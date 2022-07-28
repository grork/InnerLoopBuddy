import * as vscode from "vscode";
import { ShowOptions, BrowserView, BROWSER_VIEW_TYPE } from "./browserView";

/**
 * Captured state from a previously opened webview
 */
interface WebViewPersistedState {
    url?: string;
}

/**
 * Manages the active browser view, including registering for certain IDE-level
 * events to help with restoration
 */
export class BrowserManager {
    private _activeView?: BrowserView;

    constructor(
        private readonly extensionUri: vscode.Uri,
    ) { }

    dispose() {
        this._activeView?.dispose();
        this._activeView = undefined;
    }

    /**
     * Show a specific URL in the browser. Only one will be displayed at a time
     * @param url URL to display
     * @param options How the browser should be displayed
     */
    public show(url: string, options?: ShowOptions): void {
        // If we already have a view, we should ask it to show the URL, rather
        // than creating a new browser
        if (this._activeView) {
            this._activeView.show(url, options);
            return;
        }

        const view = BrowserView.create(this.extensionUri, url, options);
        this.registerWebviewListeners(view);
    }

    /**
     * Handle IDE-driven restoration of a previously open browser
     */
    public restore(panel: vscode.WebviewPanel, state: WebViewPersistedState): Thenable<void> {
        const url = state?.url;

        // Give up if we the URL we're being asked to restore is not parsable
        if (!url) {
            panel.dispose();
            return Promise.resolve();
        }
        
        // Supply the **existing** panel, which we're going to restore into
        const view = BrowserView.create(this.extensionUri, url, undefined, panel);
        this.registerWebviewListeners(view);
        
        return Promise.resolve();
    }

    private registerWebviewListeners(view: BrowserView) {
        view.onDispose(() => {
            if (this._activeView === view) {
                this._activeView = undefined;
            }
        });

        this._activeView = view;
    }
    
    /**
     * Listen for IDE-level events
     * @param context Extension context
     */
    public handleExtensionActivation(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer(
            BROWSER_VIEW_TYPE, {
                    deserializeWebviewPanel: this.restore.bind(this)
                }
            )
        );
    }
}