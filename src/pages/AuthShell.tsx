import type { ReactNode } from 'react';

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-marinho-900 to-marinho-700 p-4">
      <main className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/logo-192.png" alt="Logótipo da Banda Marcial de Gueifães" className="h-24 w-24" />
          <p className="mt-2 text-sm font-semibold text-slate-500">Banda Marcial de Gueifães</p>
          <h1 className="text-xl font-bold text-marinho-900">{title}</h1>
        </div>
        {children}
      </main>
    </div>
  );
}
