import { useState } from 'react';
import type { WorkshopCapability } from '../protocol.js';
import type {
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
} from '../protocol/onboarding.js';
import type { WorkshopOnboardingController } from './configuration.js';
import { hasUiCapability } from './configuration.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopOnboarding } from './onboarding.js';

export function WorkshopOnboardingScreen({
  controller,
  capabilities,
}: {
  controller?: WorkshopOnboardingController;
  capabilities: readonly WorkshopCapability[];
}) {
  const [plan, setPlan] = useState<OnboardingSeedPlan>();
  const [result, setResult] = useState<OnboardingSeedResult>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const canApply =
    hasUiCapability(capabilities, 'task-write') &&
    hasUiCapability(capabilities, 'memory-write') &&
    hasUiCapability(capabilities, 'knowledge-write');
  if (!controller) {
    return (
      <section className="workshop-panel">
        <h1>Seed research</h1>
        <p className="workshop-notice" role="status">
          The Site host must inject a Workshop onboarding preview/apply
          controller before this step can write Site state.
        </p>
      </section>
    );
  }
  const preview = async (input: OnboardingSeedInput) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setPlan(await controller.preview(input));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await controller.apply(plan));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workshop-screen" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">Seed research</h1>
      {error ? <WorkshopErrorNotice error={error} /> : null}
      <WorkshopOnboarding onPreview={preview} busy={busy} />
      {plan ? (
        <section className="workshop-panel workshop-stack" aria-live="polite">
          <h2>Proposed seed plan</h2>
          <p>
            {plan.entities.length} entities, {plan.memories.length} memories,
            and {plan.tasks.length} tasks. Review these before applying.
          </p>
          <ul>
            {plan.entities.map((entity) => (
              <li key={`${entity.kind}:${entity.label}`}>
                {entity.kind}: {entity.label}
              </li>
            ))}
          </ul>
          {canApply ? (
            <button type="button" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Applying seed…' : 'Apply this seed plan'}
            </button>
          ) : (
            <p className="workshop-notice" role="status">
              Applying requires task-write, memory-write, and knowledge-write
              capabilities.
            </p>
          )}
        </section>
      ) : null}
      {result ? (
        <p className="workshop-success" role="status">
          Seed {result.key} applied: {result.entities.length} entities,{' '}
          {result.memories.length} memories, and {result.tasks.length} tasks.
        </p>
      ) : null}
    </section>
  );
}
