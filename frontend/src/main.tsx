import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="min-h-screen bg-background text-zinc-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-surface border border-border rounded-xl p-6 shadow-xl text-center space-y-4">
        <div className="inline-flex p-3 rounded-xl bg-primary/10 text-primary mb-2">
          <span className="text-3xl">🔬</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          ConstraintLens Frontend
        </h1>
        <p className="text-sm text-zinc-400">
          AI-Powered Kanban Flow &amp; Bottleneck Simulator
        </p>
        <div className="pt-4 border-t border-border flex items-center justify-between text-xs text-zinc-500 font-mono">
          <span>React + Vite + Tailwind v3</span>
          <span className="text-emerald-400">● Online</span>
        </div>
      </div>
    </div>
  </React.StrictMode>,
)
