import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Budget, QuotaDay } from './history';
import { language, t } from './i18n';
import { UsageRecord } from './transcripts';
import { AccountUsage } from './usage';

export interface PanelAccount {
  id: string;
  label: string;
  email?: string;
  active: boolean;
  usage?: AccountUsage;
}

export interface PanelData {
  generatedAt: number;
  /** UI language and its translation table (empty for English), for the webview's own strings. */
  lang?: string;
  l10n?: Record<string, string>;
  accounts: PanelAccount[];
  records: UsageRecord[];
  /** The active account's weekly window, measured from the account-wide API value. */
  quota?: {
    account: string;
    days: QuotaDay[];
    budget: Budget;
    /** Weekly % used over the last 7 days according to the recorded samples. */
    used7d: number;
    recordedSince?: number;
  };
  files: number;
  ms: number;
  error?: string;
}

/** The usage panel webview. One instance; reopening reveals and refreshes it. */
export class UsagePanel {
  private static current: UsagePanel | undefined;

  static show(extensionUri: vscode.Uri, title: string, load: () => Promise<PanelData>): void {
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal();
      void UsagePanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel('relevo.usage', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    UsagePanel.current = new UsagePanel(panel, extensionUri, load);
  }

  private loading = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly load: () => Promise<PanelData>,
  ) {
    panel.webview.html = this.html(extensionUri);
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready' || msg?.type === 'refresh') {
        void this.refresh();
      } else if (msg?.type === 'update') {
        // Asks Claude Code itself for fresh figures (its /usage command), then redraws.
        void this.panel.webview.postMessage({ type: 'loading' });
        void vscode.commands.executeCommand('relevo.updateUsage').then(() => this.refresh());
      }
    });
    panel.onDidDispose(() => {
      UsagePanel.current = undefined;
    });
  }

  private async refresh(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    void this.panel.webview.postMessage({ type: 'loading' });
    let data: PanelData;
    try {
      data = await this.load();
    } catch (e) {
      data = { generatedAt: Date.now(), lang: language(), accounts: [], records: [], files: 0, ms: 0, error: String(e) };
    } finally {
      this.loading = false;
    }
    void this.panel.webview.postMessage({ type: 'data', data });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const media = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="${language()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('panel.css')}">
<title>${t('Claude usage')}</title>
</head>
<body>
<main id="app" class="loading"><p class="empty">${t('Reading history…')}</p></main>
<div id="tooltip" role="tooltip" hidden></div>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}
