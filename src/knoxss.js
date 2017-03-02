/*
	The background script responsible to monitor browsing activity and to live
	scan URLs via the KNOXSS service.
*/

/* keep track of the extension's state state across the tabs
   (default value in [brackets]) */
var domain_state = {
	/*
	domain: {
		active: true|[false],
		xssed: true|[false],
		is_second_level_domain: true|false,
		handle_subdomains: [true]|false,
		parent_domain: '', [empty]
		urls: [], [empty]
	}
	*/
};


function deleteDomainState(domain) {
	domain_state = {};
	browser.storage.local.set({domain_state: domain_state, current_domain: ""});
}

function storeDomainState() {
	browser.storage.local.set({domain_state: domain_state});
}

function setCurrentDomain(domain) {
	browser.storage.local.set({current_domain: domain});
}

function createState(domain) {
	var isLevel2Domain = isSecondLevelDomain(domain);
	var parentIsActive = false;
	var parentDomain = getSecondLevelDomain(domain);

	if(!isLevel2Domain) {
		// it might be a subdomain of a currently active second-level domain
		if(hasState(parentDomain)) {
			var ds = getState(parentDomain);
			parentIsActive = ds.active && ds.handle_subdomains;
		}
	}

	var newState = {
		active: parentIsActive,
		xssed: false,
		is_second_level_domain: isLevel2Domain,
		handle_subdomains: isLevel2Domain,
		parent_domain: parentDomain,
		urls: []
	};

	setState(domain, newState);
	return getState(domain);
}

function hasState(domain) {
	return (domain in domain_state);
}

function getState(domain) {
	return hasState(domain) ? domain_state[domain] : false;
}

function setState(domain, state) {
	if( !(domain in domain_state) ) {
		domain_state[domain] = {};
	}

	for(var k in state) {
		domain_state[domain][k] = state[k];
	}

	storeDomainState();
}

function getOrCreateState(domain) {
	return hasState(domain) ? getState(domain) : createState(domain);
}

/* track newly activated tabs, reflect extension state for this tab in the button UI */
browser.tabs.onActivated.addListener(tabActivated);
function tabActivated(info) {
	var tabs = browser.tabs.get(info.tabId);
	tabs.then((tab) => {
		var domain = getDomainFromURL(tab.url);
		if(isValidDomain(domain)) {
			// ensure a state entry is present for this domain
			var ds = getOrCreateState(domain);
			updateUI(tab, domain, ds);
			setPopupDomain(tab, domain);
		} else {
			console.log("Ignoring activated request on invalid domain \"" + domain + "\"");
			setPopupDomain(tab, "");
			updateUI(tab, domain, false);
		}
	});
}

/* monitor the active tab's "completed" updates */
browser.tabs.onUpdated.addListener(tabUpdate);
function tabUpdate(tabId, changeInfo, tab) {
	if( changeInfo.status == 'complete' ) {
		var currentUrl = tab.url;
		var domain = getDomainFromURL(currentUrl);
		if(isValidDomain(domain)) {
			setPopupDomain(tab, domain);

			var ds = getOrCreateState(domain);
			updateUI(tab, domain, ds);

			if( ds.active ) {
				// the extension is active for the specified domain

				// get any previously set cookie for this domain and query KNOXSS
				// with this tab's URL
				browser.cookies.getAll({domain: domain}).then((cookie) => {
					var cookies = '';
					if( cookie.length ) {
						for(var c of cookie) {
							cookies += c.name + "=" + c.value + "; ";
						}
						cookies = "Cookie:" + cookies.trim();
					}

					// query the KNOXSS service
					queryKnoxss(tab, domain, currentUrl, cookies);
				});
			}
		} else {
			console.log("Ignoring update request on invalid domain \"" + domain + "\"");
			setPopupDomain(tab, "");
			updateUI(tab, domain, false);
		}
	}
}

/* listen for incoming messages */
browser.runtime.onMessage.addListener(onMessage);
function onMessage(request, sender, sendResponse) {
	if( request.toggle ) {
		// toggle extension state for the active tab
		toggleState();
		// keep the channel open, we'll async sendResponse
		// return true;
	} else if( request.clear_state ) {
		// clear domain state
		deleteDomainState();
		syncWithActiveTab();
		// return false;
	} else if( request.handle_subdomains ) {
		// enable or disable processing of subdomains for the active tab
		setHandleSubdomains(request.value);
	}
	return false;
}

function  main() {
	console.log("This is LiveKNOXSS " + getVersion());
	syncWithActiveTab();
}

main();


/** Utilities */

/* UI and abstraction utilities */

/* enables or disables the processing of subdomains for the currently active tab */
function setHandleSubdomains(value) {
	getActiveTab().then((tabs) => {
		var tab = tabs[0];
		var domain = getDomainFromURL(tab.url);
		if(isValidDomain(domain)) {
			var ds = getOrCreateState(domain);
			ds.handle_subdomains = value;
			setState(domain, ds);
			console.log("Automatic subdomain handling " + (value ? "activated" : "deactivated") + " for \"*." + domain + "\"");

			updateSubdomainsState(domain);
			updateUI(tab, domain, ds);
		} else {
			console.log("Ignoring toggle processing subdomains request on invalid domain \"" + domain + "\"");
		}
	});
}

/* updates state for each subdomain that belongs to the specified domain */
function updateSubdomainsState(domain) {
	var ds = getOrCreateState(domain);

	// search and update for subdomains
	for(var subdomain in domain_state) {
		if(isSubdomainOf(domain, subdomain)) {
			var subds = getOrCreateState(subdomain);
			subds.active = ds.handle_subdomains && ds.active;
			console.log("Subdomain \"" + subdomain + "\" has been automatically " + (subds.active ? "activated" : "deactivated") + ", parent domain is \"" + subds.parent_domain + "\"");
		}
	}

	storeDomainState();
}

/* whether the specified domain is a subdomain of the specified domain */
function isSubdomainOf(domain, subdomain) {
	var ds = getOrCreateState(domain);
	var subds = getOrCreateState(subdomain);
	if(ds.is_second_level_domain && !subds.is_second_level_domain && subds.parent_domain === domain) {
		return true;
	}
	return false;
}

/* whether the specified domain is a second-level domain */
function isSecondLevelDomain(domain) {
	return (domain.split('.').length == 2);
}

function getSecondLevelDomain(domain) {
	// early exit
	if(isSecondLevelDomain(domain)) return domain;
	var parts = domain.split('.');
	return parts[parts.length-2] + "." + parts[parts.length-1];
}

// Stores and signal the specified domain as the currently active one
// so `storage.onChanged` listeners may react accordingly: this only
// succeed if the request comes from the active tab
function setPopupDomain(tab, domain) {
	getActiveTab().then((tabs) => {
		var activeTab = tabs[0];
		if(tab.id == activeTab.id) {
			setCurrentDomain(domain);
		}
	});
}

/* toggle the extension state for the currently active tab */
function toggleState() {
	getActiveTab().then((tabs) => {
		var tab = tabs[0];
		var domain = getDomainFromURL(tab.url);
		if(isValidDomain(domain)) {
			var ds = getOrCreateState(domain);
			ds.xssed = false;
			ds.active = !ds.active;
			setState(domain, ds);

			updateSubdomainsState(domain);
			updateUI(tab, domain, ds);
		} else {
			console.log("Ignoring toggle request on invalid domain \"" + domain + "\"");
		}
	});
}

/* trigger an force a update the state for the currently active tab */
function syncWithActiveTab() {
	getActiveTab().then((tabs) => {
		var tab = tabs[0];
		tabUpdate(tab.id, {status:'complete'}, tab);
	});
}

/* returns the extension version */
function getVersion() {
	return typeof version !== 'undefined' ? ('v' + version) : '(unknown build)';
}

/* gets the domain from the specified URL */
function getDomainFromURL(url) {
	return url.match(/(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n]+)/im)[1];
}

function isValidDomain(domain) {
	if(domain.length == 0) return false;
	if(domain.indexOf('.') == -1) return false;
	return true;
}

/* sets text and color for the button badge */
function setBadge(text, color) {
	browser.browserAction.setBadgeText({text:text});
	browser.browserAction.setBadgeBackgroundColor({color:color});
}

/* retrieve the active tab */
function getActiveTab() {
	return browser.tabs.query({active: true, currentWindow: true});
}

// update the browser_action button only if either the request comes from the active tab
// or the domain is the same for both tabs
function updateUI(tab, domain, state) {
	getActiveTab().then((tabs) => {
		var activeTab = tabs[0];
		var canUpdate = (activeTab.id == tab.id) || (getDomainFromURL(activeTab.url) === getDomainFromURL(tab.url));
		if( canUpdate ) {
			if(!state || (state && !state.active && !state.xssed)) {
				setBadge("", "");
				console.log("LiveKNOXSS not active for " + (!isValidDomain(domain) ? "invalid domain " : "") + "\"" + domain + "\"");
			} else if( state.active ) {
				setBadge("on", "#20c020");
				console.log("LiveKNOXSS active for \"" + domain + "\"");
			} else if( state.xssed ) {
				setBadge("XSS", "#ff2020");
				console.log("The KNOXSS service found an XSS vulnerability on \"" + domain + "\"!\r\nVulnerable: " + state.urls[0]);
			}
		}
	});
}

function notify(title, text) {
	if(typeof browser.notifications !== 'undefined' && browser.notifications) {
		browser.notifications.create({
			"type": "basic",
			"iconUrl": browser.extension.getURL("icons/k.png"),
			"title": title,
			"message": text
		});
	} else {
		console.log(title + ": " + text);
	}
}

function queryKnoxss(tab, domain, url, cookies) {
	console.log("Querying KNOXSS service for \"" + url + "\", auth=" + cookies + ", tabId=" + tab.id);

	var knoxssUrl = "https://knoxss.me/old/pro";

	// retrieve KNOXSS cookies
	browser.cookies.getAll({domain: "knoxss.me"}).then((kcookies) => {
		if( kcookies.length ) {
			// collect KNOXSS cookies
			var kauth = '';
			for(var c of kcookies) {
				kauth += c.name + "=" + c.value + "; ";
			}
			kauth = kauth.trim();

			// prepare KNOXSS request headers and body
			var headers = new Headers({
				'Accept': 'text/html,application/xhtml+xml,application/xml',
				'Content-Type': 'application/x-www-form-urlencoded',
				'X-WebExtension': "LiveKNOXSS " + getVersion().replace(/[^0-9A-Za-z\.\-\+]/g,""),
				'Cookie': kauth
			});

			var init = {
				method: "POST",
				body: "target=" + encodeURI(url).replace(/&/g, '%26') + "&auth=" + cookies,
				cache: "no-cache",
				credentials: "include",
				headers: headers
			};

			// make the request
			var knoxssRequest = new Request(knoxssUrl, init);

			// NOTE: the response here might come very late (network latency, connection errors..) and 
			// the state might have been updated already within the request-response time window.
			fetch(knoxssRequest).then(function(response) {
				return response.text().then(function(body) {
					// XSS found?
					if (body.match(/window.open/)) {
						// extract the vulnerable link for reproduction
						var vulnerable = body.match(/window\.open\('(.[^']*)'/)[1];

						// update state and button UI
						var ds = getState(domain);
						ds.active = false;
						ds.xssed = true;

						if( ds.urls ) {
							// collect the URL if it isn't already there
							if( ds.urls.indexOf(vulnerable) == -1 ) {
								ds.urls.push(vulnerable);
							}
						} else {
							ds.urls = [ vulnerable ];
						}

						setState(domain, ds);
						updateUI(tab, domain, ds);

						notify("LiveKNOXSS", "An XSS has been found on " + domain + "!\r\n" + encodeURI(vulnerable));
					}

					if (response.url.match(/knoxss.me\/wp-login\.php/)) {
						notify("LiveKNOXSS", "You have no permission to access this KNOXSS resource.");
					}

					var e = body.match(/ERROR\:.*!/)
					if (e) {
						var t = body.match(/<!--.*-->/)[0];
						if (t) {
							notify("LiveKNOXSS", e + "\n\r" + t.replace(/<!--|-->/g, "", t));
						} else {
							notify("LiveKNOXSS", e);
						}
					}
				});
			});
		} else {
			notify("No KNOXSS service auth cookies found: try to log into the KNOXSS Pro service again.");
		}
	});
}
