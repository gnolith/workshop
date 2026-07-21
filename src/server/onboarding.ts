import { WorkshopError } from '../protocol/errors.js';
import type { KnowledgeService } from '../protocol/knowledge.js';
import type { Memory, UpsertMemoryInput } from '../protocol/memories.js';
import type {
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
} from '../protocol/onboarding.js';
import type { CreateTaskInput, Task } from '../protocol/tasks.js';
import { requiredText } from './validation.js';

export type {
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
} from '../protocol/onboarding.js';

export interface OnboardingTaskWriter {
  create(input: CreateTaskInput, principalId?: string): Promise<Task>;
}

export interface OnboardingMemoryWriter {
  upsert(
    slug: string,
    input: UpsertMemoryInput,
    principalId?: string,
  ): Promise<Memory>;
}

export interface OnboardingServiceOptions {
  /** Host transaction boundary used when all configured writers can participate. */
  transaction?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Optional Site-specific check supporting an expected-empty seed precondition. */
  isEmpty?: (key: string) => boolean | Promise<boolean>;
}

export interface ApplyOnboardingOptions {
  expectedEmpty?: boolean;
}

export class OnboardingService {
  constructor(
    readonly tasks: OnboardingTaskWriter,
    readonly memories: OnboardingMemoryWriter,
    readonly knowledge: KnowledgeService,
    readonly options: OnboardingServiceOptions = {},
  ) {}

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
    const suppliedMemories = input.memories ?? [];
    const memories = [...suppliedMemories];
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
    const memorySlugs = memories.map((memory) => memory.slug);
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

  async apply(
    plan: OnboardingSeedPlan,
    principalId: string,
    options: ApplyOnboardingOptions = {},
  ): Promise<OnboardingSeedResult> {
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
    const operation = () => this.#apply(plan, principalId);
    return this.options.transaction
      ? this.options.transaction(operation)
      : operation();
  }

  async #apply(
    plan: OnboardingSeedPlan,
    principalId: string,
  ): Promise<OnboardingSeedResult> {
    const entities: unknown[] = [];
    for (const entity of plan.entities) {
      entities.push(
        await this.knowledge.call(
          {
            name: 'create_item',
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
            },
          },
          { principalId, requestId: `onboarding:${plan.key}` },
        ),
      );
    }
    const memories: Memory[] = [];
    for (const memory of plan.memories) {
      memories.push(
        await this.memories.upsert(memory.slug, memory.input, principalId),
      );
    }
    const tasks: Task[] = [];
    for (const task of plan.tasks) {
      tasks.push(await this.tasks.create(task, principalId));
    }
    return { key: plan.key, entities, memories, tasks };
  }
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
