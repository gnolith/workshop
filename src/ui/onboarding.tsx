import { useState } from 'react';
import type { OnboardingSeedInput } from '../protocol/onboarding.js';

export function WorkshopOnboarding({
  onPreview,
  busy = false,
}: {
  onPreview?: (input: OnboardingSeedInput) => void | Promise<void>;
  busy?: boolean;
}) {
  const [key, setKey] = useState('initial-research');
  const [language, setLanguage] = useState('en');
  const [topics, setTopics] = useState('');
  const [terms, setTerms] = useState('');
  const [people, setPeople] = useState('');
  const [places, setPlaces] = useState('');
  const [objects, setObjects] = useState('');
  const [sources, setSources] = useState('');
  const [existingResearch, setExistingResearch] = useState('');
  const [scopeBoundaries, setScopeBoundaries] = useState('');
  const [memorySlug, setMemorySlug] = useState('');
  const [memoryDescription, setMemoryDescription] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  return (
    <form
      className="workshop-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onPreview?.({
          key: key.trim(),
          defaultLanguage: language.trim(),
          topics: lines(topics),
          terms: lines(terms),
          people: lines(people),
          places: lines(places),
          objects: lines(objects),
          sources: lines(sources),
          ...(existingResearch.trim()
            ? { existingResearch: existingResearch.trim() }
            : {}),
          ...(scopeBoundaries.trim()
            ? { scopeBoundaries: scopeBoundaries.trim() }
            : {}),
          ...(memorySlug.trim() &&
          memoryDescription.trim() &&
          memoryContent.trim()
            ? {
                memories: [
                  {
                    slug: memorySlug.trim(),
                    input: {
                      description: memoryDescription.trim(),
                      content: memoryContent.trim(),
                    },
                  },
                ],
              }
            : {}),
        });
      }}
    >
      <p>
        Preview a small research seed before applying it. This creates ordinary
        Site entities, memories, and tasks—not a separate project.
      </p>
      <label>
        Idempotency key
        <input
          required
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </label>
      <label>
        Default language
        <input
          required
          value={language}
          onChange={(event) => setLanguage(event.currentTarget.value)}
        />
      </label>
      <SeedLines label="Topics" value={topics} onChange={setTopics} />
      <SeedLines label="Terms" value={terms} onChange={setTerms} />
      <SeedLines label="People" value={people} onChange={setPeople} />
      <SeedLines label="Places" value={places} onChange={setPlaces} />
      <SeedLines label="Objects" value={objects} onChange={setObjects} />
      <SeedLines label="Known sources" value={sources} onChange={setSources} />
      <label>
        Existing research orientation
        <textarea
          value={existingResearch}
          onChange={(event) => setExistingResearch(event.currentTarget.value)}
        />
      </label>
      <label>
        Scope boundaries
        <textarea
          value={scopeBoundaries}
          onChange={(event) => setScopeBoundaries(event.currentTarget.value)}
        />
      </label>
      <fieldset className="workshop-fieldset">
        <legend>Optional reusable guidance memory</legend>
        <label>
          Memory slug
          <input
            value={memorySlug}
            onChange={(event) => setMemorySlug(event.currentTarget.value)}
          />
        </label>
        <label>
          Memory purpose
          <input
            value={memoryDescription}
            onChange={(event) =>
              setMemoryDescription(event.currentTarget.value)
            }
          />
        </label>
        <label>
          Guidance
          <textarea
            value={memoryContent}
            onChange={(event) => setMemoryContent(event.currentTarget.value)}
          />
        </label>
      </fieldset>
      <button type="submit" disabled={busy}>
        {busy ? 'Preparing preview…' : 'Preview seed plan'}
      </button>
    </form>
  );
}

function SeedLines({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}, one per line
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
