import * as vscode from 'vscode';

import { HerdrService, SidebarSection } from './service.js';

/**
 * 每个 view 一个 webview，渲染 workspace / agent 其中一段（上下两块由 VSCode 原生分栏：
 * 各自滚动、可拖动分隔、各自折叠）。同一个 provider 服务两个容器下的 4 个 view id，
 * 靠 `view.viewType` 决定渲染哪一段。
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly service: HerdrService) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.service.extensionUri, 'media');
    const section: SidebarSection = view.viewType.includes('Agents') ? 'agents' : 'spaces';
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media, section);

    const disposable = this.service.attachPost((message) => void view.webview.postMessage(message));
    const messageSub = view.webview.onDidReceiveMessage((message) => void this.service.send(message));
    this.service.registerView(view, section);
    view.onDidChangeVisibility(() => this.service.notifyViewVisibility());
    view.onDidDispose(() => {
      disposable.dispose();
      messageSub.dispose();
      this.service.unregisterView(view);
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri, section: SidebarSection): string {
    const nonce = randomNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'style.css'));
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body data-section="${section}">
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}
