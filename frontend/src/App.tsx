import { Routes, Route } from 'react-router-dom';
import ModelList from './pages/ModelList';
import ModelDetail from './pages/ModelDetail';

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3">
        <a href="/3dskydb/" className="text-xl font-bold tracking-tight">
          3dsky<span className="text-cyan-400">DB</span>
        </a>
        <span className="ml-2 text-sm text-gray-500">3D Model Browser</span>
      </header>

      <main className="flex-1">
        <Routes>
          <Route path="/" element={<ModelList />} />
          <Route path="/model/:slug" element={<ModelDetail />} />
        </Routes>
      </main>

      <footer className="bg-gray-900 border-t border-gray-800 px-4 py-3 text-center text-xs text-gray-600">
        Data from{' '}
        <a href="https://3dsky.org" className="text-cyan-500 hover:underline">
          3dsky.org
        </a>
        {' '}— not affiliated.
      </footer>
    </div>
  );
}
