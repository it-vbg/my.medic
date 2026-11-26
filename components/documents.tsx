import { ArrowUpRight, Check, ChevronDown, CloudUpload, FileImage, FileText, FolderSearch, HeartPulse, Plus, ScanLine, Search, TestTubeDiagonal, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type DragEvent } from "react";
import type { Category, MedicalDocument } from "@/lib/cabinet";
import { Message } from "./portal-ui";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const categories: Record<Category, string> = { analysis: "Анализ", examination: "Обследование" };
const filters = [{ value: "all", label: "Все документы" }, { value: "analysis", label: "Анализы" }, { value: "examination", label: "Обследования" }] as const;
const supportedFiles = ["application/pdf", "image/jpeg", "image/png"];

function fileSize(bytes: number) {
  const mb = 1024 * 1024;
  if (bytes >= mb) return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(bytes / mb) + " МБ";
  return Math.max(1, Math.round(bytes / 1024)) + " КБ";
}

function EmptyArchive() {
  return (
    <div className="archive-art" aria-hidden="true">
      <span className="archive-orbit" />
      <span className="archive-back" />
      <span className="archive-paper"><HeartPulse size={23} /><i /><i /></span>
      <span className="archive-plus"><Plus size={15} strokeWidth={2.8} /></span>
    </div>
  );
}

export function Documents({ records, openUpload }: { records: MedicalDocument[]; openUpload: () => void }) {
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("ru");
    return records.filter(record => (category === "all" || record.category === category)
      && (!search || (record.title + " " + record.filename).toLocaleLowerCase("ru").includes(search)));
  }, [category, query, records]);

  return (
    <section className="page-section" aria-labelledby="documents-title">
      <div className="section-heading">
        <h1 id="documents-title">Документы</h1>
        {records.length > 0 && <button type="button" className="button button-primary" onClick={openUpload}><Plus size={18} /> Загрузить документ</button>}
      </div>
      {records.length === 0 ? (
        <div className="panel empty-archive">
          <EmptyArchive />
          <h2>В карте пока нет документов</h2>
          <p>Добавьте первый анализ или обследование.<br className="desktop-break" /> Оригинал всегда можно будет открыть здесь.</p>
          <button type="button" className="button button-primary" onClick={openUpload}><Plus size={18} /> Загрузить документ</button>
        </div>
      ) : (
        <div className="panel document-panel">
          <div className="document-tools">
            <div className="filter-strip" aria-label="Фильтр по категории" role="group">
              {filters.map(filter => <button type="button" key={filter.value} aria-pressed={filter.value === category} onClick={() => setCategory(filter.value)}>{filter.label}</button>)}
            </div>
            <div className="input-wrap search-input">
              <Search size={17} aria-hidden="true" />
              <input type="search" aria-label="Поиск документов" placeholder="Найти документ" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
          </div>
          {matches.length > 0 ? (
            <>
              <div className="document-columns document-head" aria-hidden="true"><span>Документ</span><span>Категория</span><span>Дата исследования</span><span /></div>
              <ul className="document-list" aria-label="Документы выбранной карты">
                {matches.map(record => {
                  const Icon = record.category === "analysis" ? TestTubeDiagonal : ScanLine;
                  const extension = record.mime === "application/pdf" ? "PDF" : record.mime === "image/jpeg" ? "JPG" : "PNG";
                  return <li key={record.id}>
                    <a className="document-columns document-row" href={"/api/documents/" + encodeURIComponent(record.id)} target="_blank" rel="noopener noreferrer" aria-label={"Открыть оригинал «" + record.title + "» в новой вкладке"} aria-describedby={"file-format-" + record.id + " doc-category-" + record.id + " exam-date-" + record.id}>
                      <div className="document-identity">
                        <span className={"document-icon " + record.category}><Icon size={21} /></span>
                        <span className="document-name"><strong>{record.title}</strong><small id={"file-format-" + record.id}>{extension}<span> · </span>{fileSize(record.size)}</small></span>
                      </div>
                      <span className={"category-label " + record.category} id={"doc-category-" + record.id}>{categories[record.category]}</span>
                      <time dateTime={record.examDate} id={"exam-date-" + record.id}>{dateFormatter.format(new Date(record.examDate + "T00:00:00Z"))}</time>
                      <ArrowUpRight size={18} aria-hidden="true" className="document-arrow" />
                    </a>
                  </li>;
                })}
              </ul>
            </>
          ) : (
            <div className="no-matches">
              <FolderSearch size={32} aria-hidden="true" />
              <h2>Документы не найдены</h2>
              <p>Попробуйте другое название или категорию.</p>
              <button type="button" className="button button-secondary" onClick={() => { setQuery(""); setCategory("all"); }}>Сбросить фильтры</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function localDate() {
  const now = new Date();
  return [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

export function UploadFields({ disabled, file, setFile }: { disabled: boolean; file: File | null; setFile: (file: File | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const inferredTitle = useRef("");
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const titleId = useId();
  const categoryId = useId();
  const dateId = useId();

  function chooseFiles(files: FileList | null) {
    if (disabled || !files?.length) return;
    const next = files[0];
    let problem = "";
    if (files.length > 1) problem = "Загружайте по одному файлу за раз.";
    else if (!next.size) problem = "Выбранный файл пуст. Выберите другой файл.";
    else if (next.size > 12 * 1024 * 1024) problem = "Размер файла превышает 12 МБ. Выберите файл меньшего размера.";
    else if (!supportedFiles.includes(next.type) && !/\.(pdf|jpe?g|png)$/i.test(next.name)) problem = "Выберите файл в формате PDF, JPG или PNG.";
    if (problem) {
      setFile(null);
      if (title === inferredTitle.current) setTitle("");
      inferredTitle.current = "";
      setError(problem);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setError("");
    setFile(next);
    const suggestion = (next.name.replace(/\.[^./]+$/, "") || next.name).slice(0, 140);
    if (!title || title === inferredTitle.current) setTitle(suggestion);
    inferredTitle.current = suggestion;
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    chooseFiles(event.dataTransfer.files);
  }

  return (
    <>
      <div className="field">
        <label htmlFor={fileId}>Файл документа</label>
        <div className={"drop-area" + (dragging ? " drag-active" : "") + (file ? " has-file" : "")}
          onDragEnter={event => { event.preventDefault(); if (!disabled) { dragDepth.current++; setDragging(true); } }}
          onDragOver={event => { event.preventDefault(); if (disabled) event.dataTransfer.dropEffect = "none"; }}
          onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
          onDrop={drop}>
          <input className="sr-only" id={fileId} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" aria-required="true" disabled={disabled} ref={fileInput} onChange={event => chooseFiles(event.target.files)} tabIndex={-1} />
          {file ? <>
            <span className="file-preview-icon">{file.type.startsWith("image/") ? <FileImage size={24} /> : <FileText size={24} />}</span>
            <div className="file-selected"><strong>{file.name}</strong><small><Check size={13} /> {fileSize(file.size)}</small></div>
            <button type="button" className="icon-action" aria-label="Убрать файл" disabled={disabled} onClick={() => {
              setFile(null);
              setError("");
              if (title === inferredTitle.current) setTitle("");
              inferredTitle.current = "";
              if (fileInput.current) fileInput.current.value = "";
            }}><X size={17} /></button>
          </> : <>
            <CloudUpload size={28} strokeWidth={1.6} aria-hidden="true" />
            <div><button type="button" className="text-action" disabled={disabled} onClick={() => fileInput.current?.click()}>Выберите файл</button><span className="drop-instruction"> или перетащите сюда</span></div>
            <small>PDF, JPG или PNG до 12 МБ</small>
          </>}
        </div>
        {error && <Message notice={{ kind: "error", text: error }} />}
      </div>
      <label className="field" htmlFor={titleId}><span>Название документа</span><input id={titleId} type="text" className="plain-input" name="title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={140} placeholder="Например, общий анализ крови" disabled={disabled} /></label>
      <div className="form-pair">
        <label className="field" htmlFor={categoryId}><span>Категория</span><span className="select-wrap"><select id={categoryId} className="plain-input" name="category" defaultValue="analysis" disabled={disabled}><option value="analysis">Анализ</option><option value="examination">Обследование</option></select><ChevronDown size={16} /></span></label>
        <label className="field" htmlFor={dateId}><span>Дата исследования</span><input id={dateId} className="plain-input" name="examDate" type="date" defaultValue={localDate()} required disabled={disabled} /></label>
      </div>
    </>
  );
}
