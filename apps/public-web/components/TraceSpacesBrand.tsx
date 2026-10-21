type TraceSpacesBrandProps = {
  className?: string;
  size?: "header" | "footer";
};

/** The official user-supplied TRACE artwork, paired only with a SPACES label. */
export function TraceSpacesBrand({
  className = "",
  size = "header",
}: TraceSpacesBrandProps) {
  return (
    <span
      aria-hidden="true"
      className={`trace-spaces-brand trace-spaces-brand--${size} ${className}`.trim()}
    >
      <img
        className="trace-spaces-brand__art"
        src="/trace-media/brand/trace-logo-original.jpg"
        alt=""
        width="200"
        height="200"
      />
      <span className="trace-spaces-brand__descriptor">SPACES</span>
    </span>
  );
}
