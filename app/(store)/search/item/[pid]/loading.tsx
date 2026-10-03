export default function Loading() {
  return (
    <div className="wrap page search-loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden />
      <p className="big">Getting the live price and stock…</p>
      <p className="muted">This takes a few seconds the first time anyone opens this product.</p>
    </div>
  );
}
