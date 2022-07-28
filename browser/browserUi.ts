const vscode = acquireVsCodeApi();

/**
 * Messages sent to the host of this iframe
 */
enum ToHostMessageType {
    /**
     * Open the current URL in the system browser
     */
    OpenInSystemBrowser = "open-in-system-browser",

    /**
     * The user intiated a setting change for the automatic browser cache bypass
     */
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed"
}

/**
 * Messages recieved from the host of this iframe
 */
enum FromHostMessageType {
    /**
     * The focus lock indicator setting has changed
     */
    FocusIndicatorLockEnabledStateChanged = "focus-lock-indicator-setting-changed",

    /**
     * The automatic browser cache bypass setting has changed
     */
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed",

    /**
     * Force an refresh of the focus lock state
     */
    RefreshFocusLockState = "refresh-focus-lock-state",

    /**
     * Open a URL in our browser
     */
    NavigateToUrl = "navigate-to-url"
}

const CACHE_BYPASS_PARAMETER_NAME = "ilbCacheBypassSecretParameter";

/**
 * Settings are (intially) passed in the html body as a metatag; this grabs it
 * from there, and turns it into a real instance/
 * @returns The settings object
 */
function extractSettingsFromMetaTag(): { url: string; focusLockIndicator: boolean;  automaticBrowserCacheBypass: boolean } {
    const element = document.getElementById("browser-settings");
    if (element) {
        const data = element.getAttribute("data-settings");
        if (data) {
            return JSON.parse(data);
        }
    }

    throw new Error(`Could not load settings`);
}

function toggleFocusLockIndicator() {
    document.body.classList.toggle("enable-focus-lock-indicator", settings.focusLockIndicator);
}

function updateAutomaticBrowserCacheBypassCheckboxState() {
    bypassCacheCheckbox.checked = settings.automaticBrowserCacheBypass;
}

/**
 * Sets the address bar to the currentlly set iframe URL. Intended to be used
 * when someone has changed the address bar, but we didn't navigate to the URL
 * they typed in
 */
function resetAddressBarToCurrentIFrameValue()
{
    const iframeUrl = new URL(contentIframe.src);
    iframeUrl.searchParams.delete(CACHE_BYPASS_PARAMETER_NAME);
    addressBar.value = iframeUrl.toString();
}

const settings = extractSettingsFromMetaTag();

// Locate all the buttons & elements we work with
const contentIframe = document.querySelector("iframe")!;
const addressBar = document.querySelector<HTMLInputElement>(".url-input")!;
const forwardButton = document.querySelector<HTMLButtonElement>(".forward-button")!;
const backButton = document.querySelector<HTMLButtonElement>(".back-button")!;
const bypassCacheCheckbox = document.querySelector<HTMLInputElement>("#bypassCacheCheckbox")!;
const reloadButton = document.querySelector<HTMLButtonElement>(".reload-button")!;
const openExternalButton = document.querySelector<HTMLButtonElement>(".open-external-button")!;

/**
 * Navigate the iframe to the supplied URL, including automatically appending
 * cache bypass parameters if needed
 * @param url URL to navigate to
 */
function navigateTo(url: URL): void {
    // Delete the cache bypass parameter if it's present
    if (url.searchParams.has(CACHE_BYPASS_PARAMETER_NAME)) {
        url.searchParams.delete(CACHE_BYPASS_PARAMETER_NAME);
    }

    // Save the state in the host
    vscode.setState({ url: url.toString() });
    
    // Try to bust the cache for the iframe There does not appear to be any way
    // to reliably do this except modifying the url
    if (settings.automaticBrowserCacheBypass) {
        url.searchParams.append(CACHE_BYPASS_PARAMETER_NAME, Date.now().toString());
    }

    contentIframe.src = url.toString();
    resetAddressBarToCurrentIFrameValue();
}

/**
 * Process a user change of address bar text. This will attempt to check that
 * the URL is valid, and only navigate if it is. If the URL doesn't include the
 * scheme, we will attempt to add one by default (http if local host, https
 * otherwise)
 */
function handleAddressBarChange(e: Event) {
    let rawUrl = (<HTMLInputElement>e.target).value;
    let parsedUrl: URL | null = null;
    
    // Try to parse it
    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        try {
            // Since it wasn't a successful URL, lets try adding a scheme
            if (!/^https?:\/\//.test(rawUrl)) {
                if (rawUrl.startsWith("localhost/") || rawUrl.startsWith("localhost:")) {
                    // default to http for localhost
                    rawUrl = "http://" + rawUrl;
                } else {
                    rawUrl = "https://" + rawUrl;
                }

                // Try parsing it again
                parsedUrl = new URL(rawUrl);
            }
        } catch { /* Not parsable */ }
    }

    if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
        resetAddressBarToCurrentIFrameValue();
        return;
    }
    
    navigateTo(parsedUrl!);
}

/**
 * Refresh the display of the focus lock state indicator based on the iframe
 * focus state
 */
function refreshFocusLockState(): void {
    const iframeFocused = document.activeElement?.tagName === "IFRAME";
    document.body.classList.toggle("iframe-focused", iframeFocused);
    console.log(`Focused: ${iframeFocused}`);
}

// Listen for host-sent messages
window.addEventListener("message", e => {
    switch (e.data.type) {
        case FromHostMessageType.FocusIndicatorLockEnabledStateChanged:
            settings.focusLockIndicator = e.data.focusLockIndicator;
            toggleFocusLockIndicator();
            break;
        
        case FromHostMessageType.NavigateToUrl:
            navigateTo(e.data.url);
            break;
        
        case FromHostMessageType.AutomaticBrowserCacheBybassStateChanged:
            settings.automaticBrowserCacheBypass = e.data.automaticBrowserCacheBypass;
            updateAutomaticBrowserCacheBypassCheckboxState();
            break;
        
        case FromHostMessageType.RefreshFocusLockState:
            refreshFocusLockState();
            break;
    }
});

document.addEventListener("DOMContentLoaded", () => {
    toggleFocusLockIndicator();

    // Handle focus events in the window so we can correctly indicate of focus
    // is captured by the iframe itself
    window.addEventListener("focus", refreshFocusLockState);
    window.addEventListener("blur", refreshFocusLockState);

    // When the user commits a change in the address bar, handle it
    addressBar.addEventListener("change", handleAddressBarChange);

    // Handle changes to the cache bypass checkbox
    bypassCacheCheckbox?.addEventListener("change", (e) => {
        const isChecked = (<HTMLInputElement>e.target).checked;
        vscode.postMessage({
            type: ToHostMessageType.AutomaticBrowserCacheBybassStateChanged,
            automaticBrowserCacheBypass: isChecked
        });
    })

    // Using history.go(0) does not seem to trigger what we want (reload the
    // iframe. So, we ask the page to navigate to itself again. This incorrectly
    // adds entries to the history but does reload. It also always incorrectly
    // always loads the value of the last exilicit location change of the iframe
    // which may not match the currently displayed page if they've navigated.
    reloadButton.addEventListener("click", () => navigateTo(new URL(contentIframe.src)));
    forwardButton.addEventListener("click", () => history.forward());
    backButton.addEventListener("click", () => history.back());

    openExternalButton.addEventListener("click", () => {
        vscode.postMessage({
            type: ToHostMessageType.OpenInSystemBrowser,
            url: addressBar.value
        });
    });

    navigateTo(new URL(settings.url));
});