/** Double-bezel card: hairline outer tray + inner core with concentric radius. */
export function Bezel({ as: Tag = "div", className = "", coreClassName = "", children, ...props }) {
  return (
    <Tag className={`bezel ${className}`} {...props}>
      <div className={`bezel-core h-full ${coreClassName}`}>{children}</div>
    </Tag>
  );
}
