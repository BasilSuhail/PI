import { NextResponse } from 'next/server';
import { fetchFleet } from '@/lib/fleet';

export const dynamic = 'force-dynamic';

export const GET = async () => {
  try {
    return NextResponse.json(await fetchFleet());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'discovery failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
};
