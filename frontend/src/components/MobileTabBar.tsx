import { NavLink } from 'react-router-dom';

const ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: '面试', end: true },
  { to: '/questions', label: '题库' },
  { to: '/trends', label: '成长分析' },
  { to: '/interviews/new', label: '新建' },
];

export default function MobileTabBar() {
  return (
    <nav className="mobile-tabbar" aria-label="主导航">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `mobile-tabbar-item${isActive ? ' is-active' : ''}`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
