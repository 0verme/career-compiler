import type {
  CareerIR,
  CareerProfile,
  CareerRenderer,
  RenderedArtifact,
  RendererOptions
} from '@career-compiler/core';
import {
  CAREER_IR_SCHEMA_VERSION,
  validateCareerIR,
  validateCareerProfile
} from '@career-compiler/core';

export interface GitHubProfileRendererOptions extends RendererOptions {
  fileName?: string;
}

const DEFAULT_GITHUB_PROFILE_TEMPLATE = `# {{name}}

## About

{{about}}

## What I'm Building

{{building}}

## Selected Projects

{{projects}}

## Skills / Focus Areas

{{skills}}
`;

function asIR(input: CareerIR | CareerProfile): CareerIR {
  if ('kind' in input) {
    return validateCareerIR(input);
  }
  return {
    kind: 'career-ir',
    schemaVersion: CAREER_IR_SCHEMA_VERSION,
    exportedAt: input.generatedAt,
    profile: validateCareerProfile(input),
    facts: [],
    evidence: []
  };
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

function line(value: string | undefined): string {
  return value?.trim() || '—';
}

function renderBuilding(profile: CareerProfile): string {
  if (profile.projects.length === 0) {
    return '—';
  }
  return profile.projects
    .map((project) => {
      const title = project.url ? `[${project.name}](${project.url})` : project.name;
      return `- **${title}** — ${line(project.summary)}`;
    })
    .join('\n');
}

function renderProjects(profile: CareerProfile): string {
  if (profile.projects.length === 0) {
    return '—';
  }
  return profile.projects
    .map((project) => {
      const title = project.url ? `[${project.name}](${project.url})` : project.name;
      const skills = project.skills.length > 0 ? ` · ${project.skills.join(', ')}` : '';
      return `- ${title}${skills}`;
    })
    .join('\n');
}

function renderSkills(profile: CareerProfile): string {
  return profile.skills.length > 0 ? profile.skills.map((skill) => `- ${skill.name}`).join('\n') : '—';
}

export class GitHubProfileMarkdownRenderer
  implements CareerRenderer<GitHubProfileRendererOptions>
{
  readonly rendererId = 'github-profile-markdown';
  readonly format = 'markdown' as const;

  render(input: CareerIR | CareerProfile, options: GitHubProfileRendererOptions = {}): RenderedArtifact {
    const profile = asIR(input).profile;
    const content = applyTemplate(options.template ?? DEFAULT_GITHUB_PROFILE_TEMPLATE, {
      name: profile.displayName,
      about: line(profile.about ?? profile.headline),
      building: renderBuilding(profile),
      projects: renderProjects(profile),
      skills: renderSkills(profile)
    }).trimEnd() + '\n';
    return {
      rendererId: this.rendererId,
      format: this.format,
      fileName: options.fileName ?? 'github-profile.md',
      content
    };
  }
}

export function renderGitHubProfile(
  input: CareerIR | CareerProfile,
  options: GitHubProfileRendererOptions = {}
): RenderedArtifact {
  return new GitHubProfileMarkdownRenderer().render(input, options);
}
