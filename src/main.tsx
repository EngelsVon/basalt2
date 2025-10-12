import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Polyfill: Node Buffer in browser (for solanaService and bs58 usage)
import { Buffer } from 'buffer'
if (!(globalThis as any).Buffer) {
  ;(globalThis as any).Buffer = Buffer as any
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
