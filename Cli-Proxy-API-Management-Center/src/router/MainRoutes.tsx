import { Navigate, useRoutes, type Location } from 'react-router-dom';
import { HomePage } from '@/features/home/HomePage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { ProvidersWorkbenchPage } from '@/features/providers/ProvidersWorkbenchPage';
import { AuthFilesPage } from '@/features/authFiles/AuthFilesPage';
import { KeysPage } from '@/features/keys/KeysPage';
import { AuthFilesOAuthExcludedEditPage } from '@/pages/AuthFilesOAuthExcludedEditPage';
import { AuthFilesOAuthModelAliasEditPage } from '@/pages/AuthFilesOAuthModelAliasEditPage';
import { OAuthPage } from '@/features/oauth/OAuthPage';
import { QuotaPage } from '@/features/quota/QuotaPage';
import { StatsPage } from '@/features/stats/StatsPage';
import { RoutingPage } from '@/features/routing/RoutingPage';
import { PluginResourcePage } from '@/features/plugins/PluginResourcePage';
import { PluginsPage } from '@/features/plugins/PluginsPage';
import { PluginStorePage } from '@/features/plugins/PluginStorePage';
import { ConfigPage } from '@/features/config/ConfigPage';
import { LogsPage } from '@/features/logs/LogsPage';
import { SystemPage } from '@/pages/SystemPage';
import { useAuthStore } from '@/stores';

const createMainRoutes = (supportsPlugin: boolean) => [
  { path: '/', element: <HomePage /> },
  { path: '/dashboard', element: <HomePage /> },
  { path: '/settings', element: <Navigate to="/config" replace /> },
  { path: '/api-keys', element: <Navigate to="/keys" replace /> },
  { path: '/quick-start', element: <ProvidersWorkbenchPage fixedBrand="apikeyFun" /> },
  { path: '/quick-start/*', element: <Navigate to="/quick-start" replace /> },
  { path: '/models', element: <ModelsPage /> },
  { path: '/keys', element: <KeysPage /> },
  { path: '/ai-providers', element: <ProvidersWorkbenchPage /> },
  { path: '/ai-providers/*', element: <Navigate to="/ai-providers" replace /> },
  { path: '/auth-files', element: <AuthFilesPage /> },
  { path: '/auth-files/oauth-excluded', element: <AuthFilesOAuthExcludedEditPage /> },
  { path: '/auth-files/oauth-model-alias', element: <AuthFilesOAuthModelAliasEditPage /> },
  { path: '/oauth', element: <OAuthPage /> },
  { path: '/stats', element: <StatsPage /> },
  { path: '/routing', element: <RoutingPage /> },
  { path: '/quota', element: <QuotaPage /> },
  ...(supportsPlugin
    ? [
        { path: '/plugin-pages/:pluginId/:menuIndex', element: <PluginResourcePage /> },
        { path: '/plugins', element: <PluginsPage /> },
        { path: '/plugin-store', element: <PluginStorePage /> },
        { path: '/plugins/*', element: <Navigate to="/plugins" replace /> },
      ]
    : [
        { path: '/plugin-pages/*', element: <Navigate to="/" replace /> },
        { path: '/plugins/*', element: <Navigate to="/" replace /> },
        { path: '/plugin-store', element: <Navigate to="/" replace /> },
      ]),
  { path: '/config', element: <ConfigPage /> },
  { path: '/logs', element: <LogsPage /> },
  { path: '/system', element: <SystemPage /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function MainRoutes({ location }: { location?: Location }) {
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  return useRoutes(createMainRoutes(supportsPlugin), location);
}
