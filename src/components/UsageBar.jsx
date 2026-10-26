export default function UsageBar({ percent, tone = 'low', showTicks = false }) {
  const p = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <div className={`bar bar-${tone}`} aria-hidden="true">
      <div className="bar-fill" style={{ width: `${p}%` }} />
      {showTicks && (
        <>
          <span className="bar-tick" style={{ left: '60%' }} />
          <span className="bar-tick" style={{ left: '80%' }} />
          <span className="bar-tick" style={{ left: '90%' }} />
        </>
      )}
    </div>
  )
}
