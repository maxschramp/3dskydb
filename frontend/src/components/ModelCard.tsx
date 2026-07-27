import { Link } from 'react-router-dom';
import { imageUrl } from '../api';
import type { ModelSummary } from '../types';

interface Props {
  model: ModelSummary;
}

export default function ModelCard({ model }: Props) {
  const img = imageUrl(model.first_image);
  const title = model.title_en || model.title || model.slug;
  const dateStr = model.created_at || model.slug_seeded_at;
  const date = dateStr ? new Date(dateStr).toLocaleDateString() : null;

  return (
    <Link
      to={`/model/${model.slug}`}
      className="group block"
    >
      {/* Image — 3dsky style: no borders, clean square image */}
      <div className="relative aspect-square bg-gray-100 overflow-hidden">
        {img ? (
          <img
            src={img}
            alt={title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
            No preview
          </div>
        )}
        {/* PRO badge */}
        {model.type_text === 'pro' && (
          <span className="absolute top-2 left-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-sm uppercase tracking-wide">
            PRO
          </span>
        )}
        {/* Price */}
        {model.price_usd != null && (
          <span className="absolute bottom-2 right-2 bg-white/90 text-gray-800 text-xs font-semibold px-1.5 py-0.5 rounded">
            ${model.price_usd}
          </span>
        )}
      </div>

      {/* Info below image — 3dsky style: minimal */}
      <div className="mt-1.5 px-0.5">
        <h3 className="text-[13px] text-gray-700 leading-tight line-clamp-2 group-hover:text-cyan-600 transition-colors">
          {title}
        </h3>
        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-gray-400">
          {model.category_title_en && (
            <span>{model.category_title_en}</span>
          )}
          {model.polygons && Number(model.polygons) > 0 && (
            <>
              <span>·</span>
              <span>{model.polygons.toLocaleString()} polys</span>
            </>
          )}
          {date && (
            <>
              <span>·</span>
              <span>{date}</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}

