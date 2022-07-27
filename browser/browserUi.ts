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

const iframe = document.querySelector("iframe")!;
const header = document.querySelector(".header")!;
const input = header.querySelector<HTMLInputElement>(".url-input")!;
const forwardButton = header.querySelector<HTMLButtonElement>(".forward-button")!;
const backButton = header.querySelector<HTMLButtonElement>(".back-button")!;
const reloadButton = header.querySelector<HTMLButtonElement>(".reload-button")!;
const openExternalButton = header.querySelector<HTMLButtonElement>(".open-external-button")!;

function navigateTo(rawUrl: string): void {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        // If it's not a valid URL, we aren't going to do anything with it.
        return;
    }

    if (url.searchParams.has("vscodeBrowserReqId")) {
        url.searchParams.delete("vscodeBrowserReqId");
    }

    var nakedUrl = url.toString();
    vscode.setState({ url: nakedUrl });
    input.value = nakedUrl;
    
    // Try to bust the cache for the iframe There does not appear to be any way
    // to reliably do this except modifying the url
    url.searchParams.append("vscodeBrowserReqId", Date.now().toString());

    iframe.contentWindow!.location = url.toString();
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

document.addEventListener("DOMContentLoaded", () => {
    toggleFocusLockIndicatorEnabled(settings.focusLockIndicatorEnabled);

    setInterval(() => {
        const iframeFocused = document.activeElement?.tagName === "IFRAME";
        document.body.classList.toggle("iframe-focused", iframeFocused);
    }, 50);

    input.addEventListener("change", e => navigateTo((e.target as HTMLInputElement).value));

    // Using history.go(0) does not seem to trigger what we want (reload the
    // iframe. So, we ask the page to navigate to itself again. This incorrectly
    // adds entries to the history but does reload. It also always incorrectly
    // always loads the value of the last exilicit location change of the iframe
    // which may not match the currently displayed page if they've navigated.
    reloadButton.addEventListener("click", () => navigateTo(iframe.src));
    forwardButton.addEventListener("click", () => history.forward());
    backButton.addEventListener("click", () => history.back());

    openExternalButton.addEventListener("click", () => {
        vscode.postMessage({
            type: ToHostMessageType.OpenInSystemBrowser,
            url: input.value
        });
    });

    navigateTo(settings.url);
});