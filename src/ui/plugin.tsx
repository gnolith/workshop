import type { ComponentType } from 'react';
import type { WorkshopUiOptions } from './configuration.js';
import { WorkshopDashboardScreen } from './dashboard-screen.js';
import { WorkshopEntityTasksScreen } from './entity-tasks-screen.js';
import { WorkshopMcpStatusScreen } from './mcp-status-screen.js';
import { WorkshopMemoriesScreen } from './memories-screen.js';
import { WorkshopTasksScreen } from './tasks-screen.js';

export interface WaystoneEntityPanelProps {
  entityId?: string;
}

type EmptyPluginComponent = ComponentType<Record<string, never>>;

/** Structural contract implemented by Waystone; Workshop never imports shell internals. */
export interface WaystonePlugin {
  id: string;
  name: string;
  navigation: ReadonlyArray<{
    id: string;
    label: string;
    href: string;
    capability?: string;
  }>;
  routes: ReadonlyArray<{
    id: string;
    path: string;
    component: EmptyPluginComponent;
  }>;
  dashboardPanels: ReadonlyArray<{
    id: string;
    title: string;
    component: EmptyPluginComponent;
  }>;
  onboarding: ReadonlyArray<{
    id: string;
    title: string;
    component: EmptyPluginComponent;
  }>;
  settingsPanels: ReadonlyArray<{
    id: string;
    title: string;
    capability: string;
    component: EmptyPluginComponent;
  }>;
  entityPanels: ReadonlyArray<{
    id: string;
    title: string;
    component: EmptyPluginComponent;
  }>;
}

export function createWorkshopPlugin(
  options: WorkshopUiOptions = {},
): WaystonePlugin {
  const capabilities = options.capabilities ?? ['read'];
  function TasksRoute() {
    return (
      <WorkshopTasksScreen
        capabilities={capabilities}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    );
  }
  function MemoriesRoute() {
    return (
      <WorkshopMemoriesScreen
        capabilities={capabilities}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    );
  }
  function DashboardPanel() {
    return (
      <WorkshopDashboardScreen
        capabilities={capabilities}
        {...(options.client === undefined ? {} : { client: options.client })}
      />
    );
  }
  function StatusPanel() {
    return (
      <WorkshopMcpStatusScreen
        {...(options.loadMcpStatus === undefined
          ? {}
          : { loadStatus: options.loadMcpStatus })}
      />
    );
  }
  function EntityPanel({ entityId }: WaystoneEntityPanelProps) {
    return (
      <WorkshopEntityTasksScreen
        capabilities={capabilities}
        {...(options.client === undefined ? {} : { client: options.client })}
        {...(entityId === undefined ? {} : { entityId })}
      />
    );
  }
  return {
    id: 'workshop',
    name: 'Workshop',
    navigation: [
      {
        id: 'workshop-tasks',
        label: 'Tasks',
        href: '/workshop/tasks',
        capability: 'read',
      },
      {
        id: 'workshop-memories',
        label: 'Memories',
        href: '/workshop/memories',
        capability: 'read',
      },
    ],
    routes: [
      { id: 'workshop-tasks', path: '/workshop/tasks', component: TasksRoute },
      {
        id: 'workshop-memories',
        path: '/workshop/memories',
        component: MemoriesRoute,
      },
    ],
    dashboardPanels: [
      {
        id: 'workshop-dashboard',
        title: 'Research Workshop',
        component: DashboardPanel,
      },
    ],
    onboarding: [],
    settingsPanels: [
      {
        id: 'workshop-mcp-status',
        title: 'Workshop MCP',
        capability: 'admin',
        component: StatusPanel,
      },
    ],
    entityPanels: [
      {
        id: 'workshop-related-tasks',
        title: 'Related tasks',
        component: EntityPanel as EmptyPluginComponent,
      },
    ],
  };
}

export const workshopPlugin = createWorkshopPlugin();
