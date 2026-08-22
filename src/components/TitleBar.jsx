import React from 'react';
import Icon from './Icon.jsx';

// Custom chrome for the frameless window. Standard Windows layout: app
// icon/name at the top-left, minimize/maximize/close at the top-right in
// that order (close outermost) -- `.titlebar` forces `direction: ltr` in CSS
// so this physical layout holds regardless of the app's own RTL content.
export default function TitleBar({ maximized, onMinimize, onToggleMaximize, onClose }) {
  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <img src="./icon.png" alt="" />
        <span>Soul Connection</span>
      </div>
      <div className="titlebar-drag" onDoubleClick={onToggleMaximize} />
      <div className="titlebar-controls">
        <button aria-label="کوچک‌کردن" className="tb-btn" onClick={onMinimize} title="کوچک‌کردن">
          <Icon name="winMinimize" size={13} />
        </button>
        <button aria-label={maximized ? 'بازگردانی' : 'بیشینه‌سازی'} className="tb-btn" onClick={onToggleMaximize} title={maximized ? 'بازگردانی' : 'بیشینه‌سازی'}>
          <Icon name={maximized ? 'winRestore' : 'winMaximize'} size={12} />
        </button>
        <button aria-label="بستن" className="tb-btn close" onClick={onClose} title="بستن">
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}
