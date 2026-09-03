/**
 * The registry of operational targets.
 *
 * Registration is the only way a target comes into existence, and this service
 * is the only thing that writes one. Two boundaries are worth stating plainly:
 *
 *  * **Nothing here selects code by name.** `adapterFor` maps the stored enum to
 *    an implementation through a fixed table. There is no module path, no
 *    executable, no `require` of anything a row could name.
 *  * **Nothing here stores a secret.** The schema refuses a credential-shaped
 *    value in the one field that names an external credential, and no other
 *    field can hold one.
 *
 * Deleting a target is refused while it still has history. A diagnostic run
 * records what was looked at and when; letting a delete cascade would quietly
 * erase that, and "the audit trail disappeared because someone tidied up" is not
 * a failure mode worth allowing.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import {
  adapterAcceptsCredentialRef,
  newOperationTargetSchema,
  operationTargetPatchSchema,
  type NewOperationTargetInput,
  type OperationAdapterType,
  type OperationTarget,
  type OperationTargetPatch
} from '../../shared/domain/operations';
import type { OperationDiagnosticRun } from '../../shared/domain/operations-diagnostics';
import type {
  IdGenerator,
  OperationDiagnosticRepository,
  OperationProbeAdapter,
  OperationTargetRepository
} from '../ports';

export interface OperationsRegistryDeps {
  readonly targets: OperationTargetRepository;
  readonly diagnostics: OperationDiagnosticRepository;
  readonly ids: IdGenerator;
  /**
   * One probe implementation per adapter type.
   *
   * A `Record` keyed on the enum rather than a lookup by string: adding a key
   * that the type does not know is a compile error, and a stored value that is
   * not a key of it cannot resolve to anything at all.
   */
  readonly adapters: Readonly<Record<OperationAdapterType, OperationProbeAdapter>>;
}

export class OperationsRegistry {
  constructor(private readonly deps: OperationsRegistryDeps) {}

  list(): OperationTarget[] {
    return this.deps.targets.list();
  }

  get(id: string): OperationTarget {
    const target = this.deps.targets.findById(id);
    if (!target) {
      throw new AgentRelayError('NOT_FOUND', 'That operational target no longer exists.');
    }
    return target;
  }

  create(input: NewOperationTargetInput): OperationTarget {
    const parsed = newOperationTargetSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);

    const value = parsed.data;
    this.assertNameIsFree(value.environment, value.name, null);

    return this.deps.targets.create({
      id: this.deps.ids.next(),
      name: value.name,
      environment: value.environment,
      // Identity, taken from the validated config rather than accepted as a
      // separate field, so the two can never disagree.
      adapterType: value.config.adapterType,
      config: value.config,
      credentialRef: value.credentialRef ?? null,
      enabled: value.enabled ?? true
    });
  }

  update(id: string, patch: OperationTargetPatch): OperationTarget {
    const parsed = operationTargetPatchSchema.safeParse(patch);
    if (!parsed.success) throw validationError(parsed.error.issues);

    const existing = this.get(id);
    const value = parsed.data;

    // The adapter kind is identity. A config for a different kind is a different
    // target, not an edit to this one.
    if (value.config && value.config.adapterType !== existing.adapterType) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This target is a ${existing.adapterType} target and cannot be changed into a ${value.config.adapterType} one. Register a new target instead.`
      );
    }

    const credentialRef = value.credentialRef === undefined ? existing.credentialRef : value.credentialRef;
    if (credentialRef != null && !adapterAcceptsCredentialRef(existing.adapterType)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `A ${existing.adapterType} target is opened by path and accepts no credential reference.`
      );
    }

    const environment = value.environment ?? existing.environment;
    const name = value.name ?? existing.name;
    if (environment !== existing.environment || name !== existing.name) {
      this.assertNameIsFree(environment, name, id);
    }

    // A configuration change while a probe is in flight would leave the finished
    // run describing a target that no longer matches what was read.
    if (value.config || value.environment) this.assertNotBusy(id);

    return this.deps.targets.update(id, value);
  }

  /**
   * Remove a target.
   *
   * Refused while a diagnostic is running, and refused while any history exists.
   * The second is the interesting one: the foreign key is `RESTRICT`, so the
   * database would refuse it anyway — this is here to say *why* rather than
   * surface a constraint error, and to make the policy a tested decision rather
   * than an emergent one.
   */
  delete(id: string): { removed: true } {
    this.get(id);
    this.assertNotBusy(id);

    const history = this.deps.diagnostics.countByTarget(id);
    if (history > 0) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This target has ${history} diagnostic run(s) on record and cannot be removed.`,
        {
          remediation:
            'Disable the target instead. Its history is an audit record of what was inspected and when.'
        }
      );
    }

    this.deps.targets.delete(id);
    return { removed: true };
  }

  listDiagnostics(targetId: string, limit?: number): OperationDiagnosticRun[] {
    this.get(targetId);
    return this.deps.diagnostics.listByTarget(targetId, limit);
  }

  /**
   * The implementation for a target's adapter type.
   *
   * The only place an adapter is chosen, and it is chosen by enum. There is no
   * overload taking a name, a path or a factory.
   */
  adapterFor(target: OperationTarget): OperationProbeAdapter {
    const adapter = this.deps.adapters[target.adapterType];
    if (!adapter) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `This build has no reader for a ${target.adapterType} target.`
      );
    }
    return adapter;
  }

  private assertNotBusy(id: string): void {
    const running = this.deps.diagnostics.findRunningForTarget(id);
    if (running) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A diagnostic is currently running against this target.',
        { remediation: 'Wait for it to finish, then try again.' }
      );
    }
  }

  private assertNameIsFree(environment: string, name: string, exceptId: string | null): void {
    const clash = this.deps.targets
      .list()
      .find(
        (target) => target.environment === environment && target.name === name && target.id !== exceptId
      );
    if (clash) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `A ${environment} target named "${name}" is already registered.`
      );
    }
  }
}

function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): AgentRelayError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? `${String(first.path.join('.'))}: ` : '';
  return new AgentRelayError('VALIDATION_FAILED', `${where}${first?.message ?? 'Invalid target.'}`);
}
