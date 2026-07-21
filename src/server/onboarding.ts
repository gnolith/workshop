import { WorkshopError } from '../protocol/errors.js';
import type { Memory, UpsertMemoryInput } from '../protocol/memories.js';
import type {
  OnboardingFailure,
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
  OnboardingStepKind,
} from '../protocol/onboarding.js';
import type { CreateTaskInput, Task } from '../protocol/tasks.js';
import type {
  NewOnboardingStep,
  OnboardingCheckpointStore,
  StoredOnboardingRun,
  StoredOnboardingStep,
} from './onboarding-store.js';
import { requiredText } from './validation.js';

export type {
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
} from '../protocol/onboarding.js';
export {
  SqlOnboardingCheckpointStore,
  type OnboardingCheckpointStore,
} from './onboarding-store.js';

/** Task creation must honor CreateTaskInput.idempotencyKey. */
export interface OnboardingTaskWriter {
  create(input: CreateTaskInput, principalId?: string): Promise<Task>;
}

/**
 * A replay must return the original memory when the slug and content match and
 * must conflict rather than overwrite when they do not.
 */
export interface OnboardingMemoryWriter {
  putIdempotent(
    slug: string,
    input: UpsertMemoryInput,
    context: { principalId: string; idempotencyKey: string },
  ): Promise<Memory>;
}

/**
 * The implementation must durably deduplicate by idempotencyKey. Replaying the
 * same key and input returns the original receipt; reusing a key for different
 * input must conflict. A request/audit identifier alone does not satisfy this
 * contract.
 */
export interface OnboardingEntityWriter {
  createItem(
    input: Readonly<Record<string, unknown>>,
    context: { principalId: string; idempotencyKey: string },
  ): Promise<unknown>;
}

export interface OnboardingServiceOptions {
  store: OnboardingCheckpointStore;
  /** Optional Site-specific check supporting an expected-empty seed precondition. */
  isEmpty?: (key: string) => boolean | Promise<boolean>;
  clock?: () => Date;
  createLeaseToken?: () => string;
  leaseDurationMs?: number;
  classifyFailure?: (
    error: unknown,
    step: { key: string; kind: OnboardingStepKind },
  ) => OnboardingFailure;
}

export interface ApplyOnboardingOptions {
  expectedEmpty?: boolean;
}

interface EntityStepInput {
  labels: Record<string, { language: string; value: string }>;
  descriptions: Record<string, { language: string; value: string }>;
}

interface MemoryStepInput {
  slug: string;
  input: UpsertMemoryInput;
}

export class OnboardingService {
  readonly #clock: () => Date;
  readonly #createLeaseToken: () => string;
  readonly #leaseDurationMs: number;

  constructor(
    readonly tasks: OnboardingTaskWriter,
    readonly memories: OnboardingMemoryWriter,
    readonly entities: OnboardingEntityWriter,
    readonly options: OnboardingServiceOptions,
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createLeaseToken =
      options.createLeaseToken ?? (() => crypto.randomUUID());
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 1
    ) {
      throw new WorkshopError(
        'validation_failed',
        'leaseDurationMs must be a positive integer',
      );
    }
  }

  plan(input: OnboardingSeedInput): OnboardingSeedPlan {
    const key = requiredText(input.key, 'key', 256);
    const defaultLanguage = input.defaultLanguage?.trim() || 'en';
    if (!/^[a-z]{2,12}(?:-[A-Za-z0-9]{2,12})*$/u.test(defaultLanguage)) {
      throw new WorkshopError(
        'validation_failed',
        'defaultLanguage is invalid',
      );
    }
    const entities = (
      [
        ['topic', input.topics],
        ['term', input.terms],
        ['person', input.people],
        ['place', input.places],
        ['object', input.objects],
        ['source', input.sources],
      ] as const
    ).flatMap(([kind, values]) =>
      (values ?? []).map((label) => ({
        kind,
        label: requiredText(label, `${kind} label`, 1_024),
      })),
    );
    if (entities.length > 50) {
      throw new WorkshopError(
        'limit_exceeded',
        'Onboarding seed is limited to 50 reviewable entities',
      );
    }
    const memories = [...(input.memories ?? [])];
    if (input.scopeBoundaries?.trim()) {
      memories.push({
        slug: `scope-${safeSlug(key)}`,
        input: {
          description: 'Research scope boundaries supplied during onboarding',
          content: input.scopeBoundaries.trim(),
        },
      });
    }
    if (input.existingResearch?.trim()) {
      memories.push({
        slug: `existing-research-${safeSlug(key)}`,
        input: {
          description:
            'Existing research orientation supplied during onboarding',
          content: input.existingResearch.trim(),
        },
      });
    }
    const memorySlugs = memories.map((memory) =>
      requiredText(memory.slug, 'memory slug', 256),
    );
    if (new Set(memorySlugs).size !== memorySlugs.length) {
      throw new WorkshopError(
        'validation_failed',
        'Onboarding memory slugs must be unique',
      );
    }
    const tasks = entities
      .slice(0, 10)
      .map<CreateTaskInput>((entity, index) => ({
        idempotencyKey: `onboarding:${key}:task:${index}`,
        description: `Establish the current evidence for ${entity.label}`,
        role: 'researcher',
        prompt: `Search the Site graph and available sources for ${entity.label}. Add only supported facts through the knowledge tools and report uncertainties explicitly.`,
        memorySlugs,
        contextQueries: [
          {
            label: 'Current Site knowledge',
            sparql: `SELECT ?entity ?label WHERE { ?entity <http://www.w3.org/2000/01/rdf-schema#label> ?label . FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${sparqlString(entity.label)}))) } LIMIT 25`,
          },
        ],
      }));
    return { key, defaultLanguage, entities, memories, tasks };
  }

  async get(key: string): Promise<OnboardingSeedResult | null> {
    const normalized = requiredText(key, 'key', 256);
    const run = await this.options.store.get(normalized);
    return run ? toResult(run) : null;
  }

  async resume(
    key: string,
    principalId: string,
  ): Promise<OnboardingSeedResult> {
    const normalized = requiredText(key, 'key', 256);
    const run = await this.options.store.get(normalized);
    if (!run) {
      throw new WorkshopError(
        'not_found',
        `Onboarding seed ${normalized} was not found`,
      );
    }
    return this.#run(run, requiredText(principalId, 'principalId', 256));
  }

  async apply(
    plan: OnboardingSeedPlan,
    principalId: string,
    options: ApplyOnboardingOptions = {},
  ): Promise<OnboardingSeedResult> {
    const principal = requiredText(principalId, 'principalId', 256);
    const planJson = stableJson(plan);
    let run = await this.options.store.get(plan.key);
    if (!run) {
      if (options.expectedEmpty) {
        if (!this.options.isEmpty) {
          throw new WorkshopError(
            'validation_failed',
            'The host must configure isEmpty before using expectedEmpty',
          );
        }
        if (!(await this.options.isEmpty(plan.key))) {
          throw new WorkshopError(
            'conflict',
            `Onboarding seed ${plan.key} requires an empty Site`,
          );
        }
      }
      run = await this.options.store.create(
        plan.key,
        planJson,
        principal,
        stepsFor(plan),
        this.#clock().toISOString(),
      );
    }
    if (run.planJson !== planJson) {
      throw new WorkshopError(
        'conflict',
        `Onboarding seed ${plan.key} already exists with a different plan`,
        409,
        { state: 'operator_action_required' },
      );
    }
    return this.#run(run, principal);
  }

  async #run(
    initial: StoredOnboardingRun,
    principalId: string,
  ): Promise<OnboardingSeedResult> {
    if (initial.principalId !== principalId) {
      throw new WorkshopError(
        'forbidden',
        `Onboarding seed ${initial.key} belongs to a different principal`,
      );
    }
    if (
      initial.state === 'completed' ||
      initial.state === 'operator_action_required'
    ) {
      return toResult(initial);
    }
    const now = this.#clock();
    const leaseToken = this.#createLeaseToken();
    const claimed = await this.options.store.claim(
      initial.key,
      leaseToken,
      now.toISOString(),
      new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
    );
    if (!claimed) {
      const current = await this.#requireRun(initial.key);
      if (current.state === 'completed') return toResult(current);
      throw new WorkshopError(
        'conflict',
        `Onboarding seed ${initial.key} is already being applied`,
        409,
        { state: current.state },
      );
    }

    let run = await this.#requireRun(initial.key);
    for (const step of run.steps) {
      if (step.state === 'completed') continue;
      const checkpointed = await this.options.store.markApplying(
        run.key,
        step.key,
        leaseToken,
        this.#clock().toISOString(),
      );
      if (!checkpointed) throw lostLease(run.key);
      let receipt: unknown;
      try {
        receipt = await this.#execute(step, principalId);
      } catch (error) {
        const failure = this.#classify(error, step);
        const state = failure.retryable
          ? 'retryable'
          : 'operator_action_required';
        await this.options.store.failStep(
          run.key,
          step.key,
          leaseToken,
          state,
          failure,
          this.#clock().toISOString(),
        );
        return toResult(await this.#requireRun(run.key));
      }
      const completed = await this.options.store.completeStep(
        run.key,
        step.key,
        leaseToken,
        receipt,
        this.#clock().toISOString(),
      );
      if (!completed) throw lostLease(run.key);
      run = await this.#requireRun(run.key);
    }
    const completed = await this.options.store.completeRun(
      run.key,
      leaseToken,
      this.#clock().toISOString(),
    );
    if (!completed) throw lostLease(run.key);
    return toResult(await this.#requireRun(run.key));
  }

  #execute(step: StoredOnboardingStep, principalId: string): Promise<unknown> {
    switch (step.kind) {
      case 'entity':
        return this.entities.createItem(
          step.input as Readonly<Record<string, unknown>>,
          { principalId, idempotencyKey: step.key },
        );
      case 'memory': {
        const input = step.input as MemoryStepInput;
        return this.memories.putIdempotent(input.slug, input.input, {
          principalId,
          idempotencyKey: step.key,
        });
      }
      case 'task':
        return this.tasks.create(step.input as CreateTaskInput, principalId);
    }
  }

  #classify(error: unknown, step: StoredOnboardingStep): OnboardingFailure {
    if (this.options.classifyFailure) {
      return this.options.classifyFailure(error, {
        key: step.key,
        kind: step.kind,
      });
    }
    if (error instanceof WorkshopError) {
      const retryable = [
        'dependency_unavailable',
        'query_timeout',
        'internal_error',
      ].includes(error.code);
      return { code: error.code, message: error.message, retryable };
    }
    return {
      code: 'dependency_unavailable',
      message:
        error instanceof Error ? error.message : 'Onboarding step failed',
      retryable: true,
    };
  }

  async #requireRun(key: string): Promise<StoredOnboardingRun> {
    const run = await this.options.store.get(key);
    if (!run) {
      throw new WorkshopError(
        'internal_error',
        `Onboarding seed ${key} disappeared`,
      );
    }
    return run;
  }
}

function stepsFor(plan: OnboardingSeedPlan): NewOnboardingStep[] {
  let ordinal = 0;
  return [
    ...plan.entities.map<NewOnboardingStep>((entity, index) => ({
      key: `onboarding:${plan.key}:entity:${index}`,
      ordinal: ordinal++,
      kind: 'entity',
      input: {
        labels: {
          [plan.defaultLanguage]: {
            language: plan.defaultLanguage,
            value: entity.label,
          },
        },
        descriptions: {
          [plan.defaultLanguage]: {
            language: plan.defaultLanguage,
            value: `${entity.kind} seeded during research onboarding`,
          },
        },
      } satisfies EntityStepInput,
    })),
    ...plan.memories.map<NewOnboardingStep>((memory, index) => ({
      key: `onboarding:${plan.key}:memory:${index}`,
      ordinal: ordinal++,
      kind: 'memory',
      input: memory satisfies MemoryStepInput,
    })),
    ...plan.tasks.map<NewOnboardingStep>((task, index) => ({
      key: `onboarding:${plan.key}:task:${index}`,
      ordinal: ordinal++,
      kind: 'task',
      input: {
        ...task,
        idempotencyKey: `onboarding:${plan.key}:task:${index}`,
      },
    })),
  ];
}

function toResult(run: StoredOnboardingRun): OnboardingSeedResult {
  const completed = run.steps.filter((step) => step.state === 'completed');
  return {
    key: run.key,
    state: run.state,
    retryable: run.state === 'retryable',
    completedSteps: completed.length,
    totalSteps: run.steps.length,
    steps: run.steps.map((step) => ({
      key: step.key,
      ordinal: step.ordinal,
      kind: step.kind,
      state: step.state,
      attempts: step.attempts,
      ...(step.failure ? { failure: step.failure } : {}),
    })),
    ...(run.failure ? { failure: run.failure } : {}),
    entities: completed
      .filter((step) => step.kind === 'entity')
      .map((step) => step.receipt),
    memories: completed
      .filter((step) => step.kind === 'memory')
      .map((step) => step.receipt as Memory),
    tasks: completed
      .filter((step) => step.kind === 'task')
      .map((step) => step.receipt as Task),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function lostLease(key: string): WorkshopError {
  return new WorkshopError(
    'conflict',
    `Onboarding seed ${key} lost its workflow lease`,
  );
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 64) || 'seed'
  );
}

function sparqlString(value: string): string {
  return JSON.stringify(value);
}
