import type { Memory, UpsertMemoryInput } from './memories.js';
import type { CreateTaskInput, Task } from './tasks.js';

export interface OnboardingSeedInput {
  key: string;
  defaultLanguage?: string;
  topics?: string[];
  terms?: string[];
  people?: string[];
  places?: string[];
  objects?: string[];
  sources?: string[];
  existingResearch?: string;
  scopeBoundaries?: string;
  memories?: Array<{ slug: string; input: UpsertMemoryInput }>;
}

export interface OnboardingSeedPlan {
  key: string;
  defaultLanguage: string;
  entities: Array<{
    kind: 'topic' | 'term' | 'person' | 'place' | 'object' | 'source';
    label: string;
  }>;
  memories: Array<{ slug: string; input: UpsertMemoryInput }>;
  tasks: CreateTaskInput[];
}

export type OnboardingRunState =
  | 'pending'
  | 'running'
  | 'retryable'
  | 'operator_action_required'
  | 'completed';

export type OnboardingStepState =
  | 'pending'
  | 'applying'
  | 'completed'
  | 'retryable'
  | 'operator_action_required';

export type OnboardingStepKind = 'entity' | 'memory' | 'task';

export interface OnboardingFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface OnboardingStepProgress {
  key: string;
  ordinal: number;
  kind: OnboardingStepKind;
  state: OnboardingStepState;
  attempts: number;
  failure?: OnboardingFailure;
}

export interface OnboardingSeedResult {
  key: string;
  state: OnboardingRunState;
  retryable: boolean;
  completedSteps: number;
  totalSteps: number;
  steps: OnboardingStepProgress[];
  failure?: OnboardingFailure;
  entities: unknown[];
  memories: Memory[];
  tasks: Task[];
}
