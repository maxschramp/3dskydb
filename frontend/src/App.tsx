import { useState } from 'react';
import { Routes, Route, useSearchParams } from 'react-router-dom';
import ModelList from './pages/ModelList';
import ModelDetail from './pages/ModelDetail';
import Sidebar from './components/Sidebar';

export default function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      next.set('search', searchInput.trim());
    } else {
      next.delete('search');
    }
    next.set('page', '1');
    setSearchParams(next);
  }

  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* Top bar — 3dsky style */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 sticky top-0 z-50">
        <a href="/3dskydb/" className="text-xl font-bold tracking-tight text-gray-800 flex-shrink-0">
          3dsky<span className="text-cyan-600">DB</span>
        </a>
        <form onSubmit={handleSearchSubmit} className="flex-1 max-w-xl">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search 3D Models..."
            className="w-full bg-gray-100 border border-gray-300 rounded px-4 py-2 text-sm
                       text-gray-700 placeholder-gray-400
                       focus:outline-none focus:border-cyan-500 focus:bg-white"
          />
        </form>
        <a
          href="https://3dsky.org"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-gray-500 hover:text-cyan-600 flex-shrink-0"
        >
          Upload model ↗
        </a>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex-1 flex">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <Routes>
            <Route path="/" element={<ModelList />} />
            <Route path="/model/:slug" element={<ModelDetail />} />
          </Routes>
        </main>
      </div>

      {/* Footer — 3dsky style */}
      <footer className="bg-gray-100 border-t border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
        <p>Data from{' '}
          <a href="https://3dsky.org" className="text-cyan-600 hover:underline">3dsky.org</a>
          {' '}— not affiliated.
        </p>
      </footer>
    </div>
  );
}

