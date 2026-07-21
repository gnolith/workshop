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

export interface OnboardingSeedResult {
  key: string;
  entities: unknown[];
  memories: Memory[];
  tasks: Task[];
}
