/** The Rekon brand mark alone (no wordmark) -- cropped from `logo/rekon-logo`'s
 * lockup, `currentColor`-based so it inherits whatever text color its
 * container sets (matches how the lucide placeholder icon it replaces used
 * to behave). This app is dark-theme-only, so only the "dark" (light-stroke)
 * variant's geometry is needed. */
export function RekonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 45 361 360" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M295.135 45.5727L237.835 167.7L180.535 225.001L123.235 282.301L65.9349 404.428" stroke="currentColor" strokeWidth="42" />
      <path d="M65.9331 45.5727L123.233 167.7L180.533 225.001L237.833 282.301L295.133 404.428" stroke="currentColor" strokeWidth="42" />
      <path d="M359.96 274.773L237.832 282.301L180.532 225.001L123.232 167.701L1.10438 175.228" stroke="currentColor" strokeWidth="42" />
      <path d="M359.96 175.228L237.832 167.7L180.532 225L123.232 282.3L1.10434 274.773" stroke="currentColor" strokeWidth="42" />
    </svg>
  );
}
