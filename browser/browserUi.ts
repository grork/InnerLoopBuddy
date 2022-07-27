const vscode = acquireVsCodeApi();

enum ToHostMessageType {
    OpenInSystemBrowser = "open-in-system-browser"
}

enum FromHostMessageType {
    FocusIndicatorLockEnabledStateChanged = "focus-lock-indicator-setting-changed",
    NavigateToUrl = "navigate-to-url"
}

function getSettings() {
    const element = document.getElementById("browser-settings");
    if (element) {
        const data = element.getAttribute("data-settings");
        if (data) {
            return JSON.parse(data);
        }
    }

    throw new Error(`Could not load settings`);
}

function toggleFocusLockIndicatorEnabled(enabled: boolean) {
    document.body.classList.toggle("enable-focus-lock-indicator", enabled);
}

const settings = getSettings();

const contentIframe = document.querySelector("iframe")!;
const locationBar = document.querySelector<HTMLInputElement>(".url-input")!;
const forwardButton = document.querySelector<HTMLButtonElement>(".forward-button")!;
const backButton = document.querySelector<HTMLButtonElement>(".back-button")!;
const reloadButton = document.querySelector<HTMLButtonElement>(".reload-button")!;
const openExternalButton = document.querySelector<HTMLButtonElement>(".open-external-button")!;

function navigateTo(url: URL): void {
    if (url.searchParams.has("vscodeBrowserReqId")) {
        url.searchParams.delete("vscodeBrowserReqId");
    }

    var nakedUrl = url.toString();
    vscode.setState({ url: nakedUrl });
    locationBar.value = nakedUrl;
    
    // Try to bust the cache for the iframe There does not appear to be any way
    // to reliably do this except modifying the url
    url.searchParams.append("vscodeBrowserReqId", Date.now().toString());

    contentIframe.src = url.toString();
}

window.addEventListener("message", e => {
    switch (e.data.type) {
        case FromHostMessageType.FocusIndicatorLockEnabledStateChanged:
            toggleFocusLockIndicatorEnabled(e.data.enabled);
            break;
        
        case FromHostMessageType.NavigateToUrl:
            navigateTo(e.data.url);
            break;
    }
});

function resetAddressBarToCurrentIFrameValue()
{
    const iframeUrl = new URL(contentIframe.src);
    iframeUrl.searchParams.delete("vscodeBrowserReqId");
    locationBar.value = iframeUrl.toString();
}

document.addEventListener("DOMContentLoaded", () => {
    toggleFocusLockIndicatorEnabled(settings.focusLockIndicatorEnabled);

    setInterval(() => {
        const iframeFocused = document.activeElement?.tagName === "IFRAME";
        document.body.classList.toggle("iframe-focused", iframeFocused);
    }, 50);

    locationBar.addEventListener("change", e => {
        let rawUrl = (<HTMLInputElement>e.target).value;
        let parsedUrl: URL | null = null;
        
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            try {
                if (!/^https?:\/\//.test(rawUrl)) {
                    if (rawUrl.startsWith("localhost/") || rawUrl.startsWith("localhost:")) {
                        // default to http
                        rawUrl = "http://" + rawUrl;
                    } else {
                        rawUrl = "https://" + rawUrl;
                    }

                    parsedUrl = new URL(rawUrl);
                }
            } catch { /* Not parsable */ }
        }

        if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
            resetAddressBarToCurrentIFrameValue();
            return;
        }
        
        navigateTo(parsedUrl!);
    });

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
            url: locationBar.value
        });
    });

    navigateTo(new URL(settings.url));
});