import * as vscode from "vscode";
import { ShowOptions, BrowserView, BROWSER_VIEW_TYPE } from "./browserView";

interface WebViewPersistedState {
    url?: string;
}

export class BrowserManager {

    private _activeView?: BrowserView;

    constructor(
        private readonly extensionUri: vscode.Uri,
    ) { }

    dispose() {
        this._activeView?.dispose();
        this._activeView = undefined;
    }

    public show(url: string, options?: ShowOptions): void {
        if (this._activeView) {
            this._activeView.show(url, options);
            return;
        }

        const view = BrowserView.create(this.extensionUri, url, options);
        this.registerWebviewListeners(view);
    }

    public restore(panel: vscode.WebviewPanel, state: WebViewPersistedState): Thenable<void> {
        const url = state?.url;
        if (!url) {
            panel.dispose();
            return Promise.resolve();
        }
        
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
    
    public handleExtensionActivation(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer(
            BROWSER_VIEW_TYPE, {
                    deserializeWebviewPanel: this.restore.bind(this)
                }
            )
        );
    }
}