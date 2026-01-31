import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>PrecisionMed</h1>
      <p>Landing page placeholder. SMART login and visualizations go here.</p>
      <ul>
        <li><Link href="/smart/callback">SMART Callback (test)</Link></li>
        <li><Link href="/api/health">API Health</Link></li>
      </ul>
    </main>
  );
}
