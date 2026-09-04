import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <div className="error-page">
      <div>
        <h1>Project not found</h1>
        <p className="muted">
          That project id does not exist in MongoDB — it may never have been created, or the database was reset since the
          link was generated.
        </p>
        <p className="small faint mono-sm">Every prompt creates a brand new project; nothing is cached or reused.</p>
        <Link href="/" className="btn btn--primary">
          Start a new project
        </Link>
      </div>
    </div>
  );
}
