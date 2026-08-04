import { NavLink, Outlet } from 'react-router-dom';
import { Flame, Github, TrendingUp, LayoutDashboard, Database } from 'lucide-react';
import { useAppInfo } from '@lark-apaas/client-toolkit/hooks/useAppInfo';
import { cn } from '@client/src/lib/utils';

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '今日热点', icon: Flame },
  { path: '/trending/github', label: 'GitHub 热榜', icon: Github },
  { path: '/trending/weibo', label: '微博热搜', icon: TrendingUp },
  { path: '/workbench', label: '运营工作台', icon: LayoutDashboard },
  { path: '/sources', label: '源管理', icon: Database },
];

const Layout = () => {
  const { appName } = useAppInfo();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight text-foreground">
              {appName || 'AI 前沿资讯'}
            </span>
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-colors duration-150 ease-out whitespace-nowrap',
                    isActive
                      ? 'text-primary border-b-2 border-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  )
                }
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
