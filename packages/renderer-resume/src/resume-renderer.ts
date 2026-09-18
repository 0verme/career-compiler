import type {
  CareerAchievement,
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

export interface ResumeRendererOptions extends RendererOptions {
  fileName?: string;
}

const DEFAULT_RESUME_TEMPLATE = `# {{name}}

{{headline}}

## Summary

{{summary}}

## Experience

{{experience}}

## Projects

{{projects}}

## Skills

{{skills}}

## Achievements

{{achievements}}
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

function renderExperience(profile: CareerProfile): string {
  if (profile.experiences.length === 0) {
    return '—';
  }
  return profile.experiences
    .map((experience) => {
      const dates = [experience.startDate, experience.endDate].filter(Boolean).join(' – ');
      const heading = experience.organization
        ? `### ${experience.role} · ${experience.organization}`
        : `### ${experience.role}`;
      return [heading, dates ? `_${dates}_` : '', line(experience.summary)].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function renderProjects(profile: CareerProfile): string {
  if (profile.projects.length === 0) {
    return '—';
  }
  return profile.projects
    .map((project) => {
      const title = project.url ? `### [${project.name}](${project.url})` : `### ${project.name}`;
      const skills = project.skills.length > 0 ? `\nFocus: ${project.skills.join(', ')}` : '';
      return `${title}\n${line(project.summary)}${skills}`;
    })
    .join('\n\n');
}

function renderSkills(profile: CareerProfile): string {
  return profile.skills.length > 0 ? profile.skills.map((skill) => `- ${skill.name}`).join('\n') : '—';
}

const ACHIEVEMENT_DETAILS: Array<[string, keyof CareerAchievement]> = [
  ['Problem', 'problem'],
  ['Constraint', 'constraint'],
  ['Decision', 'decision'],
  ['Action', 'action'],
  ['Result', 'result']
];

function renderAchievements(profile: CareerProfile): string {
  if (profile.achievements.length === 0) {
    return '—';
  }
  return profile.achievements
    .map((achievement) => {
      const head = `- ${achievement.statement}${achievement.metric ? ` (${achievement.metric})` : ''}`;
      const details = ACHIEVEMENT_DETAILS.flatMap(([label, key]) => {
        const value = achievement[key];
        return typeof value === 'string' && value.trim().length > 0
          ? [`  - ${label}: ${value}`]
          : [];
      });
      return [head, ...details].join('\n');
    })
    .join('\n');
}

export class ResumeMarkdownRenderer
  implements CareerRenderer<ResumeRendererOptions>
{
  readonly rendererId = 'resume-markdown';
  readonly format = 'markdown' as const;

  render(input: CareerIR | CareerProfile, options: ResumeRendererOptions = {}): RenderedArtifact {
    const ir = asIR(input);
    const profile = ir.profile;
    const content = applyTemplate(options.template ?? DEFAULT_RESUME_TEMPLATE, {
      name: profile.displayName,
      headline: line(profile.headline),
      summary: line(profile.about),
      experience: renderExperience(profile),
      projects: renderProjects(profile),
      skills: renderSkills(profile),
      achievements: renderAchievements(profile)
    }).trimEnd() + '\n';
    return {
      rendererId: this.rendererId,
      format: this.format,
      fileName: options.fileName ?? 'resume.md',
      content
    };
  }
}

export function renderResume(
  input: CareerIR | CareerProfile,
  options: ResumeRendererOptions = {}
): RenderedArtifact {
  return new ResumeMarkdownRenderer().render(input, options);
}
