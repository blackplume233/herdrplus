import * as vscode from 'vscode';

import { SidebarProvider } from './sidebar.js';
import { HerdrService, supportsSecondarySidebar } from './service.js';

export function activate(context: vscode.ExtensionContext): void {
  const service = new HerdrService(context);
  const provider = new SidebarProvider(service);

  const secondarySidebar = supportsSecondarySidebar();
  void vscode.commands.executeCommand('setContext', 'herdrplus.noSecondarySidebar', !secondarySidebar);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'herdrplus.openClient';
  const renderStatus = (): void => {
    const state = service.state;
    const snapshot = service.snapshot;
    const label = state.kind === 'ready' ? `${state.transport}` : state.kind === 'connecting' ? 'connecting' : 'offline';
    const counts = snapshot
      ? ` · ${snapshot.workspaces.length}ws/${snapshot.panes.length}pane`
      : '';
    status.text = `$(terminal) herdr: ${label}${counts}`;
    status.tooltip =
      state.kind === 'error'
        ? state.message
        : `herdr ${state.kind === 'ready' ? state.version : ''}（点击打开 herdr 终端）`;
    status.show();
  };
  service.onStateCallback = renderStatus;
  service.onSnapshotCallback = renderStatus;
  renderStatus();

  context.subscriptions.push(
    service,
    status,
    vscode.window.registerWebviewViewProvider('herdrplus.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerWebviewViewProvider('herdrplus.sidebarSecondary', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerWebviewViewProvider('herdrplus.sidebarAgents', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerWebviewViewProvider('herdrplus.sidebarAgentsSecondary', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerTerminalProfileProvider('herdr', {
      provideTerminalProfile: () => service.terminalProfile(),
    }),
    vscode.commands.registerCommand('herdrplus.refresh', () => service.refresh()),
    vscode.commands.registerCommand('herdrplus.sort', () => service.toggleSort()),
    vscode.commands.registerCommand('herdrplus.sweepWorkspaces', () => service.sweepWorkspaces()),
    vscode.commands.registerCommand('herdrplus.newWorkspace', () => service.newWorkspace()),
    vscode.commands.registerCommand('herdrplus.openClient', () => service.openClient()),
    vscode.commands.registerCommand('herdrplus.newTerminal', () => service.newTerminalView()),
    vscode.commands.registerCommand('herdrplus.newTerminalHere', () => service.newTerminalHere()),
    vscode.commands.registerCommand('herdrplus.startAgent', () => service.startAgent({ mode: 'newTerminal' })),
    vscode.commands.registerCommand('herdrplus.startAgentHere', () =>
      service.startAgent({ mode: 'here', paneId: undefined }),
    ),
    vscode.commands.registerCommand('herdrplus.locate', () => service.locateCommand()),
    vscode.commands.registerCommand('herdrplus.installDocs', () => service.installDocs()),
    vscode.commands.registerCommand('herdrplus.openFloating', () => service.openFloating()),
    vscode.commands.registerCommand('herdrplus.doctor', () => service.doctor()),
  );

  void service.init();
}

export function deactivate(): void {
  // 资源释放由 context.subscriptions 负责。
}
