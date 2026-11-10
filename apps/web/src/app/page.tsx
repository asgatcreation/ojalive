import { formatNaira, naira } from '@ojalive/shared';

const milestones = [
  { n: 1, name: 'Design & plan', done: true },
  { n: 2, name: 'Monorepo, CI, licence, Docker', done: true },
  { n: 3, name: 'Pure bid engine + property tests', done: false },
  { n: 4, name: 'Atomic bid acceptance + exactly-once closing', done: false },
  { n: 5, name: 'Socket.IO layer, resync, clock sync', done: false },
  { n: 6, name: 'Flexible category engine', done: false },
  { n: 7, name: 'Public site & live bidding UI', done: false },
  { n: 8, name: 'Deposits, settlement, ledger', done: false },
  { n: 9, name: 'Seller & staff consoles', done: false },
  { n: 10, name: 'Demo seed, bot bidders, deploy', done: false },
  { n: 11, name: 'Load, race & chaos results', done: false },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-10 px-4 py-16">
      <header className="space-y-4">
        <p className="text-sm font-medium tracking-widest text-oja-green-600 uppercase dark:text-oja-gold-400">
          Nigeria’s live auction house
        </p>
        <h1 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
          Ojà <span className="text-oja-green-600 dark:text-oja-gold-400">Live</span>
        </h1>
        <p className="max-w-xl text-lg" style={{ color: 'var(--muted)' }}>
          Real-time bidding on vehicles, phones, electronics, art, watches and corporate asset
          disposals — with proxy bids, anti-sniping soft close, and a winner that is correct even
          when a thousand people bid in the same second.
        </p>
      </header>

      <section
        className="rounded-2xl border p-6"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <h2
          className="text-sm font-semibold tracking-wide uppercase"
          style={{ color: 'var(--muted)' }}
        >
          Under construction
        </h2>
        <ol className="mt-4 space-y-2">
          {milestones.map((milestone) => (
            <li key={milestone.n} className="flex items-baseline gap-3 text-sm">
              <span
                aria-hidden="true"
                className={
                  milestone.done
                    ? 'inline-block size-2 shrink-0 rounded-full bg-oja-green-500'
                    : 'inline-block size-2 shrink-0 rounded-full border'
                }
                style={milestone.done ? undefined : { borderColor: 'var(--border)' }}
              />
              <span className={milestone.done ? '' : 'opacity-60'}>
                <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
                  {milestone.n}.
                </span>{' '}
                {milestone.name}
                {milestone.done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="space-y-2 text-sm" style={{ color: 'var(--muted)' }}>
        <p>
          Example hammer price, formatted in integer kobo:{' '}
          <strong className="text-oja-gold-500">{formatNaira(naira(8_200_000))}</strong>
        </p>
        <p>
          Designed and built by{' '}
          <a
            className="underline decoration-dotted underline-offset-4"
            href="https://github.com/asgatcreation"
          >
            Akanji Oluwaseun Gabriel
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
