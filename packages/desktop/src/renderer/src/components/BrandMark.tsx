interface BrandMarkProps {
  size?: number;
}

export default function BrandMark({ size = 30 }: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className="brand-mark"
    >
      <rect x="2" y="2" width="44" height="44" rx="14" fill="#10241d" stroke="#2c5a49" strokeWidth="1.5" />
      <path
        d="M14 30.5V20.8C14 19.8 14.8 19 15.8 19h5.6c1 0 1.8.8 1.8 1.8v9.7c0 1-.8 1.8-1.8 1.8h-5.6c-1 0-1.8-.8-1.8-1.8Z"
        fill="#8fe6c0"
      />
      <path
        d="M25.4 22.4 33 18.3c.9-.5 2 .2 2 1.2v9.1c0 1-1.1 1.7-2 1.2l-7.6-4.1a1.3 1.3 0 0 1 0-2.3Z"
        fill="#e7b86a"
      />
      <circle cx="19" cy="24.4" r="1.6" fill="#0b1512" />
    </svg>
  );
}
