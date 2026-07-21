export function WorkshopLoadingStatus({ label }: { label: string }) {
  return (
    <p className="workshop-loading" role="status" aria-live="polite">
      {label}
    </p>
  );
}
