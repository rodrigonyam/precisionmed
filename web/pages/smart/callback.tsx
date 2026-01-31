import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

export default function SmartCallback() {
  const router = useRouter();
  const { code, state } = router.query;
  const [message, setMessage] = useState('Processing SMART callback...');

  useEffect(() => {
    if (code) {
      setMessage(`Received code: ${code}. Exchange this with your backend.`);
    }
  }, [code]);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>SMART Callback</h1>
      <p>{message}</p>
      {state && <p>State: {state}</p>}
    </main>
  );
}
