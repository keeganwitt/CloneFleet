import {
  CHANGES_OPTIONS,
  SYNC_OPTIONS,
  defaultFilters,
  isFiltering,
  type ChangesFilter,
  type Filters,
  type SyncFilter,
} from "../filters";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function FilterBar({ filters, onChange }: Props) {
  return (
    <div className="toolbar">
      <input
        type="search"
        aria-label="Search repositories"
        placeholder="Search name, path, or branch"
        value={filters.search}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
      />
      <select
        aria-label="Filter by changes"
        value={filters.changes}
        onChange={(event) => onChange({ ...filters, changes: event.target.value as ChangesFilter })}
      >
        {CHANGES_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by sync"
        value={filters.sync}
        onChange={(event) => onChange({ ...filters, sync: event.target.value as SyncFilter })}
      >
        {SYNC_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {isFiltering(filters) && (
        <button className="link" onClick={() => onChange(defaultFilters)}>
          Clear filters
        </button>
      )}
    </div>
  );
}
