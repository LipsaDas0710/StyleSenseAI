export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function ScoreBar({ value }) {
  return (
    <span className="score" title={`Score ${value} / 100`}>
      <span className="score-num">{value}</span>
      <span className="score-track">
        <span className="score-fill" style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <p className="muted" role="status">{label}</p>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <strong>{error.code ?? 'Error'}:</strong> {error.message}
      {Array.isArray(error.details) && (
        <ul>
          {error.details.map((d) => (
            <li key={d.path + d.message}>
              <code>{d.path || '(body)'}</code> {d.message}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" className="link" onClick={() => onRetry()}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'info' }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}
