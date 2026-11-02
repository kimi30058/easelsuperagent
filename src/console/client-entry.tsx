/** Console page entry: injects the console skin over the shared panel styles and mounts the console shell. */
import { createRoot } from 'react-dom/client'
import SKIN from './console.css?raw'
import { ConsoleApp } from './shell.tsx'

const style = document.createElement('style'); style.textContent = SKIN; document.head.append(style)
createRoot(document.getElementById('root')!).render(<ConsoleApp />)
