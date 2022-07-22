import * as vscode from "vscode";
import { ShowOptions, BrowserView } from "./browserView";

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
        } else {
            const view = BrowserView.create(this.extensionUri, url, options);
            this.registerWebviewListeners(view);

            this._activeView = view;
        }
    }

    public restore(panel: vscode.WebviewPanel, state: any): void {
        const url = state?.url ?? "";
        const view = BrowserView.restore(this.extensionUri, url, panel);
        this.registerWebviewListeners(view);
        return;
    }

    private registerWebviewListeners(view: BrowserView) {
        view.onDispose(() => {
            if (this._activeView === view) {
                this._activeView = undefined;
            }
        });
    }
    
    public handleExtensionActivation(context: vscode.ExtensionContext) {
        const manager = new BrowserManager(context.extensionUri);
        context.subscriptions.push(manager);
    
        context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(BrowserView.viewType, {
            deserializeWebviewPanel: async (panel, state) => {
                manager.restore(panel, state);
            }
        }));
    }
}