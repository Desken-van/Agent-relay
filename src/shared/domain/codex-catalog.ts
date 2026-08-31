/**
 * The Codex model catalogue, as the renderer is allowed to see it.
 *
 * Lives in `shared` because both the IPC contract and the port that produces it
 * refer to these shapes, and nothing inward may import an adapter — or, for that
 * matter, anything from `main`.
 *
 * The fields here are the whole allow-list. Listing models involves an
 * `initialize` handshake that answers with `codexHome`, `userAgent` and platform
 * details; none of it appears below, and that omission is the point.
 */

export interface CodexModelOption {
  /**
   * The slug stored on a task and passed to `ThreadOptions.model`.
   *
   * The catalogue also carries an `id`, which is used only for matching inside
   * the adapter and never crosses this boundary. They are equal in every model
   * observed so far, which is precisely why the distinction is written down.
   */
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly isDefault: boolean;
}

export interface CodexModelCatalogResult {
  readonly available: boolean;
  readonly models: readonly CodexModelOption[];
  /** Short, safe explanation when unavailable. Never raw tool output. */
  readonly detail: string | null;
}
