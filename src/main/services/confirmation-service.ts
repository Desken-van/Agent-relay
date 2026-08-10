/**
 * The native confirmation gate.
 *
 * This deliberately uses Electron's own modal dialog rather than a React modal.
 * A React modal lives in the renderer, and the renderer is the least trusted
 * part of the application — if it were the gate, then anything that could call
 * the IPC bridge could also "click yes". A main-process modal cannot be
 * dismissed by renderer code at all.
 *
 * Default button is always Cancel, and the dialog spells out the account,
 * repository, visibility, branch and exact action before anything happens.
 */

import { dialog, type BrowserWindow } from 'electron/main';
import type { PublishConfirmation } from '../../shared/ipc';
import type { ConfirmationService } from '../ports';

const ACTION_BUTTONS: Record<PublishConfirmation['action'], string> = {
  commit: 'Create commit',
  push: 'Push branch',
  create_repository: 'Create repository',
  create_pull_request: 'Open pull request'
};

export class ElectronConfirmationService implements ConfirmationService {
  private window: BrowserWindow | null = null;

  attach(window: BrowserWindow): void {
    this.window = window;
  }

  async confirm(request: PublishConfirmation): Promise<boolean> {
    const scope = request.affectsRemote
      ? 'This action reaches GitHub and is visible to others.'
      : 'This action only changes files on this machine.';

    const detail = [
      `Account / owner:  ${request.account}`,
      `Repository:       ${request.repository}`,
      `Visibility:       ${request.visibility}`,
      `Branch:           ${request.branch}`,
      '',
      ...request.details,
      '',
      scope
    ].join('\n');

    return this.ask({
      title: 'Agent Relay — confirm',
      message: request.headline,
      detail,
      confirmLabel: ACTION_BUTTONS[request.action],
      dangerous: request.affectsRemote
    });
  }

  async confirmSimple(request: {
    headline: string;
    detail: string;
    details: readonly string[];
    confirmLabel: string;
  }): Promise<boolean> {
    return this.ask({
      title: 'Agent Relay — confirm',
      message: request.headline,
      detail: [request.detail, '', ...request.details].join('\n'),
      confirmLabel: request.confirmLabel,
      dangerous: false
    });
  }

  private async ask(options: {
    title: string;
    message: string;
    detail: string;
    confirmLabel: string;
    dangerous: boolean;
  }): Promise<boolean> {
    const config = {
      type: 'warning' as const,
      // Index 0 is Cancel and is both the default and the Escape action, so a
      // stray Enter or Escape can never approve anything.
      buttons: ['Cancel', options.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: options.title,
      message: options.message,
      detail: options.detail
    };

    const result = this.window
      ? await dialog.showMessageBox(this.window, config)
      : await dialog.showMessageBox(config);

    return result.response === 1;
  }
}

/** Always denies. The safe default when no UI is attached (e.g. headless tests). */
export class DenyingConfirmationService implements ConfirmationService {
  async confirm(): Promise<boolean> {
    return false;
  }

  async confirmSimple(): Promise<boolean> {
    return false;
  }
}
