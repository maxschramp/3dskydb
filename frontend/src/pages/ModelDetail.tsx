import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchModel, imageUrl, modelPageUrl } from '../api';
import type { ModelDetail } from '../types';

export default function ModelDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [model, setModel] = useState<ModelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    fetchModel(slug)
      .then((data) => {
        if (data.success) {
          setModel(data.model);
        } else {
          setError(data.error || 'Not found');
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-6 animate-pulse space-y-4">
        <div className="h-4 bg-gray-100 rounded w-48" />
        <div className="h-96 bg-gray-100 rounded" />
        <div className="h-4 bg-gray-100 rounded w-2/3" />
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-16 text-center">
        <p className="text-red-500 text-lg">{error || 'Model not found'}</p>
        <Link to="/" className="text-cyan-600 hover:underline mt-4 inline-block text-sm">
          &larr; Back to all models
        </Link>
      </div>
    );
  }

  const displayTitle = model.title_en || model.title || model.slug;
  const mainImage = imageUrl(model.images[selectedImage]?.web_path ?? null);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Breadcrumb — 3dsky style */}
      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-5">
        <Link to="/" className="hover:text-cyan-600 transition-colors">3D Models</Link>
        {model.category_title && (
          <>
            <span>/</span>
            <Link
              to={`/?category=${model.category_slug}`}
              className="hover:text-cyan-600 transition-colors"
            >
              {model.category_title_en || model.category_title}
            </Link>
          </>
        )}
        {model.subcategory_title && (
          <>
            <span>/</span>
            <span className="text-gray-500">{model.subcategory_title_en || model.subcategory_title}</span>
          </>
        )}
      </div>

      {/* Main content: image + info panel */}
      <div className="grid lg:grid-cols-[1fr_360px] gap-8">
        {/* Image gallery */}
        <div>
          {mainImage ? (
            <img
              src={mainImage}
              alt={displayTitle}
              className="w-full rounded bg-gray-50"
            />
          ) : (
            <div className="aspect-[4/3] bg-gray-50 rounded flex items-center justify-center text-gray-400 text-sm">
              No preview available
            </div>
          )}

          {model.images.length > 1 && (
            <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
              {model.images.map((img, i) => {
                const thumb = imageUrl(img.web_path);
                if (!thumb) return null;
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedImage(i)}
                    className={`flex-shrink-0 w-16 h-16 rounded overflow-hidden border-2 transition-colors ${
                      i === selectedImage
                        ? 'border-cyan-500'
                        : 'border-transparent hover:border-gray-300'
                    }`}
                  >
                    <img
                      src={thumb}
                      alt={`Preview ${i + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Info panel — 3dsky style */}
        <div>
          {/* Title + type badge */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <h1 className="text-lg font-medium text-gray-800 leading-snug">{displayTitle}</h1>
            {model.type_text === 'pro' && (
              <span className="flex-shrink-0 text-xs font-bold bg-red-500 text-white px-2 py-0.5 rounded-sm uppercase">
                PRO
              </span>
            )}
          </div>

          {/* Price + View on 3dsky button */}
          {model.price_usd != null && (
            <div className="flex items-center gap-3 mb-5">
              <span className="text-2xl font-bold text-gray-800">${model.price_usd.toFixed(2)}</span>
              <a
                href={modelPageUrl(model.slug)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
              >
                View on 3dsky.org
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 2h5v5M10 2L2 10" />
                </svg>
              </a>
            </div>
          )}

          {/* Stats grid — 3dsky style: two-column with icons */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
            {model.polygons != null && <Stat label="Polygons" value={model.polygons.toLocaleString()} />}
            {model.vertices != null && <Stat label="Vertices" value={model.vertices.toLocaleString()} />}
            {model.size_kb != null && <Stat label="File size" value={formatSize(model.size_kb)} />}
            {model.length_cm != null && (
              <Stat label="Dimensions" value={`${model.length_cm}×${model.width_cm}×${model.height_cm} cm`} />
            )}
            {model.platform && <Stat label="Platform" value={model.platform} />}
            {model.render && <Stat label="Renderer" value={model.render} />}
            {model.style_en && <Stat label="Style" value={model.style_en} />}
            {model.form_title_en && <Stat label="Form" value={model.form_title_en} />}
          </div>

          {/* Dates */}
          <DatesSection model={model} />

          {/* Description */}
          {(model.description_en || model.description) && (
            <div
              className="text-sm text-gray-500 leading-relaxed mb-4 max-h-32 overflow-y-auto
                         [&_a]:text-cyan-600 [&_a]:underline [&_a]:break-all"
              dangerouslySetInnerHTML={{
                __html: model.description_en || model.description || '',
              }}
            />
          )}

          {/* Tags */}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {model.tags.map((tag, i) => (
                <span key={i} className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                  {tag.title}
                </span>
              ))}
            </div>
          )}

          {/* Materials */}
          {model.materials.length > 0 && (
            <Section title="Materials">
              <div className="flex flex-wrap gap-1">
                {model.materials.map((mat, i) => (
                  <span key={i} className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                    {mat.material_en || mat.material}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Colors */}
          {model.colors.length > 0 && (
            <Section title="Colors">
              <div className="flex flex-wrap gap-1.5">
                {model.colors.map((col, i) => (
                  <div key={i} className="flex items-center gap-1 text-xs text-gray-500">
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-gray-300 inline-block"
                      style={{ backgroundColor: col.hex ? `#${col.hex}` : '#ccc' }}
                    />
                    {col.title_en || col.title}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Formats */}
          {model.formats.length > 0 && (
            <Section title="File Formats">
              <div className="flex flex-wrap gap-1">
                {model.formats.map((fmt, i) => (
                  <span key={i} className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                    {fmt.title}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* AI warning */}
          {model.is_created_with_ai === 1 && (
            <p className="text-xs text-amber-600 mt-3">⚠ This model was created with AI</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-sm text-gray-700">{value}</div>
    </div>
  );
}

function DatesSection({ model }: { model: ModelDetail }) {
  const dates: { label: string; value: string | null }[] = [
    { label: 'Published', value: formatDate(model.created_at) },
    { label: 'Updated', value: formatDate(model.version) },
    { label: 'Indexed', value: formatDate(model.slug_seeded_at) },
    { label: 'Detail fetched', value: formatDate(model.detail_fetched_at) },
  ].filter((d) => d.value);

  if (dates.length === 0) return null;

  return (
    <Section title="Dates">
      <div className="text-xs text-gray-400 space-y-0.5">
        {dates.map((d) => (
          <div key={d.label} className="flex gap-2">
            <span className="w-24">{d.label}</span>
            <span className="text-gray-500">{d.value}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function formatSize(kb: number): string {
  if (kb >= 1_048_576) return `${(kb / 1_048_576).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

