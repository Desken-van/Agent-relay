/**
 * A plan-review subject factory that makes no Git call.
 *
 * It keeps the one property the gate service depends on and the real factory
 * guarantees: the identity is fixed by the request, so the same request names the same
 * subject and a different gate names a different one. Ids look like Git object ids so
 * anything that validates their shape sees what it would see in production.
 */

import { createHash } from 'node:crypto';
import type { PlanReviewSubjectFactory, PlanReviewSubjectRequest } from '../../src/main/ports';

export class FakePlanReviewSubjects implements PlanReviewSubjectFactory {
  readonly requests: PlanReviewSubjectRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  error: Error | null = null;
  /** Held open so a test decides when the subject comes back. */
  gate: Promise<unknown> | null = null;

  async createIsolatedSubject(request: PlanReviewSubjectRequest, signal?: AbortSignal): Promise<string> {
    this.requests.push(request);
    this.signals.push(signal);
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    return createHash('sha1')
      .update([request.repositoryPath, request.branch, request.gateId, request.specificationSha256, request.createdAt].join('\0'))
      .digest('hex');
  }
}
