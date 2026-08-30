import { NextResponse } from 'next/server';
import { fetchContainers } from '@/lib/glances';
import { fetchTailnetDevices, ipv4Of } from '@/lib/tailnet';

export const dynamic = 'force-dynamic';

export const GET = async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;

  const device = (await fetchTailnetDevices()).find((d) => d.id === id);
  if (!device) return NextResponse.json({ error: 'unknown node' }, { status: 404 });

  const ip = ipv4Of(device);
  if (!ip) return NextResponse.json({ error: 'node has no IPv4 address' }, { status: 409 });

  return NextResponse.json(await fetchContainers(ip));
};
