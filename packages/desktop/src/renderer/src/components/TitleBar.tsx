import BrandMark from './BrandMark';

export default function TitleBar(): React.JSX.Element {
  return (
    <header className="title-bar">
      <div className="title-bar-brand">
        <BrandMark size={21} />
        <span>OpenMeet</span>
      </div>
      <div className="title-bar-drag" />
      <div className="title-bar-meta">本地优先 · 开源自托管</div>
    </header>
  );
}
