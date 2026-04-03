import Link from 'next/link';

export default function PortalSelect() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-5xl font-bold tracking-widest text-amber-400">GUARD</h1>
      <p className="text-gray-400 tracking-widest text-sm">Select your portal</p>
      <div className="flex flex-col gap-4 w-full max-w-xs">
        <Link href="/admin" className="border border-amber-400 text-amber-400 text-center py-3 rounded-lg tracking-widest hover:bg-amber-400 hover:text-gray-900 transition-colors">
          ADMIN DASHBOARD
        </Link>
        <Link href="/client" className="border border-blue-400 text-blue-400 text-center py-3 rounded-lg tracking-widest hover:bg-blue-400 hover:text-gray-900 transition-colors">
          CLIENT PORTAL
        </Link>
        <Link href="/vishnu" className="border border-gray-600 text-gray-400 text-center py-3 rounded-lg tracking-widest hover:bg-gray-700 transition-colors">
          SUPER ADMIN
        </Link>
      </div>
    </main>
  );
}
